#!/usr/bin/env python3
"""Run the same FWSS regression scenarios against two committed revisions."""

import argparse
import copy
import importlib.util
import json
import os
import re
import shutil
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
    for name in (
        "RPC_URL",
        "PRIVATE_KEY",
        "FWSS_DISPATCH_REPORT",
        "FWSS_BASELINE_ABI",
        "FWSS_PAY_SERVICES_REPO",
        "FWSS_PAY_CANDIDATE",
        "FWSS_PAY_EVIDENCE_DIR",
    ):
        env.pop(name, None)
    # scenario_environment needs resolved package details, so apply it after init
    # and checkout verification, before scenarios can make any transactions.
    binary = str(args.binary.resolve())
    record = report[side]
    record["status"] = "FAIL"
    started = False
    step = "disk-check"
    try:
        # One devnet needs 4-8 GB for checkouts, binaries and chain data, and the
        # Docker disk image usually grows on the same volume.
        free = shutil.disk_usage(directory).free
        if free < args.min_free_gib * 2**30:
            raise ValueError(
                f"{free / 2**30:.1f} GiB free, need {args.min_free_gib} GiB (--min-free-gib)"
            )
        step = "init"

        def execute(name, argv, timeout=3600, attempts=1):
            # Builds and start fetch dependencies from the network and fail on
            # transient errors. Retried steps log each attempt and are recorded.
            nonlocal step
            step = name
            for attempt in range(1, attempts + 1):
                print(
                    f"{side}: {name}"
                    + (f" (attempt {attempt})" if attempt > 1 else ""),
                    flush=True,
                )
                suffix = "" if attempt == 1 else f"-attempt{attempt}"
                log = directory / f"{name}{suffix}.log"
                rc = command(argv, env, log, timeout)
                if not rc:
                    return
                if attempt < attempts:
                    record.setdefault("retried_steps", {})[name] = attempt
                    if name == "start":
                        command(
                            [binary, "stop"], env, directory / "stop-retry.log", 180
                        )
            raise RuntimeError(f"{name} exited {rc}; see {log}")

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
        execute("build-lotus", [binary, "build", "lotus"], attempts=args.attempts)
        execute("build-curio", [binary, "build", "curio"], attempts=args.attempts)
        step = "pre-start-daemon-check"
        require_unused_devnet_daemon()
        started = True
        execute("start", [binary, "start"], timeout=1800, attempts=args.attempts)
        env["FWSS_BASELINE_ABI"] = str(output / "baseline-abi.json")
        env["FWSS_DISPATCH_REPORT"] = str(directory / "dispatch.json")
        scenario_args = [sys.executable, str(ROOT / "scenarios/run.py")]
        scenario_timeout = 14400
        if args.fwss_pay_only:
            scenario_args.append("--fwss-pay-only")
            scenario_timeout = 17000
        else:
            scenario_args.append("--fwss-regression")
            if args.fwss_pay:
                scenario_args.append("--fwss-pay")
                scenario_timeout += 16500
        if args.fwss_pay or args.fwss_pay_only:
            env["FWSS_PAY_EVIDENCE_DIR"] = str(directory / "pay-evidence")
            # The baseline devnet is upgraded in place to the candidate; the
            # candidate devnet deploys Pay v2 fresh, if the candidate has it.
            if side == "baseline":
                env["FWSS_PAY_SERVICES_REPO"] = report["services_repository"]
                env["FWSS_PAY_CANDIDATE"] = report["candidate"]["commit"]
        if side == "candidate" and args.require_dispatch:
            scenario_args.append("--require-dispatch")
        if args.keep_running:
            # Lets later scenario runs reuse this network without the caller's shell.
            (directory / "scenario-env.json").write_text(
                json.dumps(
                    {k: v for k, v in env.items() if os.environ.get(k) != v}, indent=2
                )
                + "\n"
            )
        # Covers the sum of the per-scenario timeouts in the chosen order.
        execute("scenarios", scenario_args, timeout=scenario_timeout)
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
        if started and not args.keep_running:
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
                elif run_id:
                    remove_owned_portainer(run_id)
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                record.update(status="FAIL", cleanup_error=str(error))
        # A devnet that failed to stop may still be mounted by its containers.
        if base.exists() and not (
            args.keep_running or args.keep_devnet or "cleanup_error" in record
        ):
            try:
                shutil.rmtree(base)
            except OSError as error:
                record.update(cleanup_error=f"devnet removal: {error}")
        write_summary(output, report)


def remove_owned_portainer(run_id):
    # The normal stop command intentionally retains Portainer. A comparison must
    # release its own instance before the next side checks for an idle daemon.
    container_ids = subprocess.check_output(
        ["docker", "ps", "-aq", "--filter", f"name=^foc-{run_id}-portainer$"], text=True
    ).split()
    if container_ids:
        subprocess.run(
            ["docker", "rm", "-f", *container_ids], check=True, capture_output=True
        )


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
    parser.add_argument("--baseline", default="v1.6.0")
    parser.add_argument("--candidate", default="origin/main")
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
        "--attempts",
        type=int,
        default=2,
        help="Attempts for the network-bound build and start steps (default 2)",
    )
    parser.add_argument(
        "--require-dispatch",
        action="store_true",
        help="Fail unless candidate actually deploys ERC-8167 and preserves baseline public methods",
    )
    parser.add_argument(
        "--fwss-pay",
        action="store_true",
        help="Also run test_fwss_pay_v2: the baseline is upgraded in place to the candidate",
    )
    parser.add_argument(
        "--fwss-pay-only",
        action="store_true",
        help="Run test_fwss_pay_v2 instead of the FWSS regression scenarios",
    )
    parser.add_argument(
        "--only",
        choices=("baseline", "candidate"),
        help="Run one revision instead of the comparison",
    )
    parser.add_argument(
        "--keep-running",
        action="store_true",
        help="Leave the DevNet running after the scenarios; requires --only",
    )
    parser.add_argument(
        "--keep-devnet",
        action="store_true",
        help="Keep each stopped DevNet directory (4-8 GB) instead of deleting it",
    )
    parser.add_argument(
        "--min-free-gib",
        type=float,
        default=25,
        help="Refuse to start a revision with less free disk space (default 25)",
    )
    args = parser.parse_args()
    if args.keep_running and not args.only:
        parser.error("--keep-running requires --only")
    if args.fwss_pay and args.fwss_pay_only:
        parser.error("--fwss-pay and --fwss-pay-only are exclusive")
    if args.fwss_pay_only and args.require_dispatch:
        parser.error("--require-dispatch needs the FWSS regression scenarios, not --fwss-pay-only")
    sides = (args.only,) if args.only else ("baseline", "candidate")
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
        # Both revisions run on the PDPVerifier the candidate ships with: the one
        # live networks run when the candidate deploys. v1.4.0's gitlink reports
        # VERSION 3.4.0 but requires processPieceDeletions, which Curio only runs
        # for versions above 3.4.0, so scheduled removals would never drain.
        pdp = subprocess.check_output(
            [
                "git",
                "-C",
                str(repo),
                "ls-tree",
                report["candidate"]["commit"],
                "service_contracts/lib/pdp",
            ],
            text=True,
        ).split()
        if len(pdp) != 4 or pdp[:2] != ["160000", "commit"]:
            raise ValueError("Candidate has no PDP submodule gitlink")
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
        for side in {"baseline", "candidate"} - set(sides):
            report[side]["status"] = "NOT_RUN"
        for side in sides:
            run_side(args, side, report, common, output)
            upgrade_log = output / side / "pay-evidence" / "upgrade.log"
            if side == "baseline" and upgrade_log.is_file():
                if "PAY_V2_UPGRADE_OK" in upgrade_log.read_text():
                    report["migration"] = "baseline upgraded in place by test_fwss_pay_v2"
            if report[side].get("cleanup_error"):
                break
        report["status"] = (
            "PASS"
            if all(report[side].get("status") == "PASS" for side in sides)
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
