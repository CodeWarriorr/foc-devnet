#!/usr/bin/env python3
"""Run the same FWSS regression scenarios against two committed revisions."""

import argparse
import copy
import importlib.util
import json
import os
import re
import signal
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

SPEC = importlib.util.spec_from_file_location(
    "dependencies", ROOT / "scripts/resolve-ci-dependencies.py"
)
dependencies = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(dependencies)


def command(argv, env, log, timeout):
    with log.open("w") as stream:
        process = subprocess.Popen(
            argv,
            cwd=ROOT,
            env=env,
            stdout=stream,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            return process.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise


def run_side(args, side, report, common, output):
    directory = output / side
    directory.mkdir()
    base = directory / "devnet"
    metadata_path = directory / "dependencies.json"
    metadata = copy.deepcopy(common)
    components = metadata["components"]
    components["filecoin-services"].update(
        source="git",
        repository=report["services_repository"],
        commit=report[side]["commit"],
    )
    metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    env = {
        **os.environ,
        "FOC_DEVNET_BASEDIR": str(base),
        "PATH": str(base / "bin") + os.pathsep + os.environ["PATH"],
        "REPORT_FILE": str(directory / "scenarios.md"),
        "SCENARIO_RUN_TYPE": side,
        "DEVNET_INFO": str(base / "state/latest/devnet-info.json"),
        "DEVNET_INFO_PATH": str(base / "state/latest/devnet-info.json"),
    }
    for name in ("RPC_URL", "PRIVATE_KEY", "FWSS_DISPATCH_REPORT", "FWSS_BASELINE_ABI"):
        env.pop(name, None)
    # scenario_environment needs resolved package details, so apply it after init
    # and checkout verification, before scenarios can make any transactions.
    binary = str(args.binary.resolve())
    record = report[side]
    record["status"] = "FAIL"
    started = False
    step = "init"
    try:

        def execute(name, argv, timeout=3600):
            nonlocal step
            step = name
            print(f"{side}: {name}", flush=True)
            rc = command(argv, env, directory / f"{name}.log", timeout)
            if rc:
                raise RuntimeError(
                    f"{name} exited {rc}; see {directory / (name + '.log')}"
                )

        execute("init", [binary, "init", *dependencies.build_init_args(components)])
        step = "verify-checkouts"
        dependencies.verify(
            argparse.Namespace(
                metadata=metadata_path, code_dir=base / "code", github_output=None
            )
        )
        metadata = json.loads(metadata_path.read_text())
        # Reuse exact dependencies resolved by the first initialized network.
        for name in ("lotus", "curio"):
            common["components"][name].update(
                source="git", commit=metadata["components"][name]["commit"]
            )
        env.update(
            dependencies.scenario_environment(metadata_path, metadata["components"])
        )
        execute("build-lotus", [binary, "build", "lotus"])
        execute("build-curio", [binary, "build", "curio"])
        step = "pre-start-daemon-check"
        require_unused_devnet_daemon()
        started = True
        execute("start", [binary, "start"], timeout=1800)
        env["FWSS_BASELINE_ABI"] = str(output / "baseline-abi.json")
        env["FWSS_DISPATCH_REPORT"] = str(directory / "dispatch.json")
        scenario_args = [
            sys.executable,
            str(ROOT / "scenarios/run.py"),
            "--fwss-regression",
        ]
        if side == "candidate" and args.require_dispatch:
            scenario_args.append("--require-dispatch")
        execute("scenarios", scenario_args, timeout=3600)
        record["status"] = "PASS"
    except (
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as error:
        record.update(failed_step=step, error=str(error))
    finally:
        if started:
            try:
                run_file = base / "state/current_runid.json"
                run_id = (
                    json.loads(run_file.read_text())["run_id"]
                    if run_file.exists()
                    else None
                )
                require_unused_devnet_daemon(run_id)
                rc = command([binary, "stop"], env, directory / "stop.log", 180)
                if rc:
                    record.update(status="FAIL", cleanup_error=f"stop exited {rc}")
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                record.update(status="FAIL", cleanup_error=str(error))
        write_summary(output, report)


def revision(repository, ref):
    return subprocess.check_output(
        [
            "git",
            "-C",
            str(repository),
            "rev-parse",
            "--verify",
            "--end-of-options",
            ref + "^{commit}",
        ],
        text=True,
    ).strip()


def write_summary(output, report):
    (output / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")


def require_unused_devnet_daemon(allowed_run_id=None):
    # start/stop sweep all foc-devnet containers, not just FOC_DEVNET_BASEDIR.
    containers = subprocess.check_output(
        ["docker", "ps", "-a", "--format", "{{.Names}} {{.Image}}"], text=True
    ).splitlines()
    for row in containers:
        name, image = row.split()
        if allowed_run_id and name.startswith(f"foc-{allowed_run_id}-"):
            continue
        if name.startswith("foc-") or image.split(":")[0] in {
            "foc-builder",
            "foc-lotus",
            "foc-lotus-miner",
            "foc-curio",
        }:
            raise ValueError(
                f"Existing foc-devnet container {name}; use an idle Docker daemon"
            )
    networks = subprocess.check_output(
        ["docker", "network", "ls", "--format", "{{.Name}}"], text=True
    ).splitlines()
    if any(
        re.fullmatch(r"foc_.+_(lot-net|lot-m-net|cur-m-net-\d+)", name)
        and not (allowed_run_id and name.startswith(f"foc_{allowed_run_id}_"))
        for name in networks
    ):
        raise ValueError("Existing foc-devnet networks; use an idle Docker daemon")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--services-repo",
        type=Path,
        required=True,
        help="Local filecoin-services repository; only committed contents are tested",
    )
    parser.add_argument("--baseline", default="v1.4.0")
    parser.add_argument("--candidate", default="refactor/fwss-modular-dispatch")
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="New directory for isolated DevNets and results",
    )
    parser.add_argument(
        "--prepare-only",
        action="store_true",
        help="Resolve refs without starting or changing a DevNet",
    )
    parser.add_argument("--binary", type=Path, default=ROOT / "target/debug/foc-devnet")
    parser.add_argument(
        "--dependencies",
        type=Path,
        help="Reuse metadata from resolve-ci-dependencies.py instead of resolving the default profile",
    )
    parser.add_argument(
        "--require-dispatch",
        action="store_true",
        help="Fail unless candidate actually deploys ERC-8167 and preserves baseline public methods",
    )
    args = parser.parse_args()
    repo = args.services_repo.resolve()
    report = {
        "scope": "fresh-deployment FWSS lifecycle; not a populated-proxy migration",
        "require_candidate_dispatch": args.require_dispatch,
        "migration": "NOT_RUN",
        "services_repository": str(repo),
        "baseline": {"ref": args.baseline, "commit": revision(repo, args.baseline)},
        "candidate": {"ref": args.candidate, "commit": revision(repo, args.candidate)},
        "status": "NOT_RUN",
    }
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    output.chmod(0o700)
    write_summary(output, report)
    if args.prepare_only:
        print(f"Resolved comparison: {output / 'comparison.json'}")
        return 0
    # Init logs may contain development keys. Keep this run private, including logs.
    os.umask(0o077)
    try:
        require_unused_devnet_daemon()
        pdp = subprocess.check_output(
            [
                "git",
                "-C",
                str(repo),
                "ls-tree",
                report["baseline"]["commit"],
                "service_contracts/lib/pdp",
            ],
            text=True,
        ).split()
        if len(pdp) != 4 or pdp[:2] != ["160000", "commit"]:
            raise ValueError("Baseline has no PDP submodule gitlink")
        if args.dependencies:
            common = json.loads(args.dependencies.read_text())
        else:
            metadata_path = output / "dependencies.json"
            dependencies.resolve(
                argparse.Namespace(
                    manifest=ROOT / "ci/dependency-profiles.json",
                    profile="default",
                    output=metadata_path,
                    github_output=None,
                    github_env=None,
                )
            )
            common = json.loads(metadata_path.read_text())
        common["components"]["pdp"].update(source="git", commit=pdp[2])
        abi = subprocess.run(
            [
                "git",
                "-C",
                str(repo),
                "show",
                report["baseline"]["commit"]
                + ":service_contracts/abi/FilecoinWarmStorageService.abi.json",
            ],
            capture_output=True,
            text=True,
        )
        if args.require_dispatch and abi.returncode:
            raise ValueError("Baseline ABI is required for dispatcher verification")
        if abi.returncode == 0:
            (output / "baseline-abi.json").write_text(abi.stdout)
        for side in ("baseline", "candidate"):
            run_side(args, side, report, common, output)
            if report[side].get("cleanup_error"):
                break
        report["status"] = (
            "PASS"
            if all(
                report[side].get("status") == "PASS"
                for side in ("baseline", "candidate")
            )
            else "FAIL"
        )
    except (
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as error:
        report.update(status="FAIL", error=str(error))
    write_summary(output, report)
    print(f"{report['status']}: {output / 'comparison.json'}")
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        raise SystemExit(f"FWSS regression failed: {error}")
