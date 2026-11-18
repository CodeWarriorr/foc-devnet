#!/usr/bin/env python3
"""FWSS payments on Filecoin Pay v1 and v2, across the FWSS upgrade that adds v2.

Picks its mode from the devnet and the environment:
  - upgrade: FWSS_PAY_SERVICES_REPO and FWSS_PAY_CANDIDATE are set and the
    devnet runs a dispatcher release without Pay v2. Prepares Pay v1 data sets,
    upgrades FWSS in place with the candidate's josuke procedure, then checks
    the v1 data sets keep working and new data sets work on Pay v2.
  - v2: the devnet deployed Pay v2 (devnet-info exports filecoin_pay_v2_addr).
    Checks new data sets on Pay v2.
  - baseline: otherwise. Checks Pay v1 only.

Optional environment:
  FWSS_PAY_PENDING       steps expected to fail for now (comma-separated, `prefix*` allowed)
  FWSS_PAY_EVIDENCE_DIR  where to keep logs, ledgers and results (default: a new temp dir)
  FWSS_PAY_UPGRADE_DELAY_EPOCHS  announce delay for the upgrade (default 40)
"""

import os, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import re
import subprocess
import tempfile
from pathlib import Path

from scenarios.helpers import assert_ok, fail, info, ok, write_random_file
from scenarios.synapse_runtime import prepare_synapse_runtime
from scenarios.test_fwss_lifecycle import _lifecycle_environment
from scenarios.test_fwss_transition import _candidate_checkout

RAND_FILE_NAME = "fwss_pay_file"
RAND_FILE_SIZE = 1024 * 1024
RAND_FILE_SEED = 8170
PHASE_TIMEOUT_SECS = 5400
UPGRADE_SCRIPT = Path(__file__).resolve().parent / "fwss-pay-upgrade.sh"
# USER_3: the standard scenarios use USER_1 and USER_2, and exact balance checks need an untouched payer.
PAYER_INDEX = "2"
FAILING = {"FAIL", "FIXED"}


def choose_mode(devnet: dict, environ: dict) -> str:
    if devnet.get("contracts", {}).get("filecoin_pay_v2_addr"):
        return "v2"
    if environ.get("FWSS_PAY_SERVICES_REPO") and environ.get("FWSS_PAY_CANDIDATE"):
        return "upgrade"
    return "baseline"


def summarize(results: list[dict]) -> tuple[list[str], bool]:
    """One line per step, and whether any step fails the run."""
    lines = [
        f"{r['status']:8} {r['phase']:8} {r['name']}"
        + (f" ({r['detail'].splitlines()[0]})" if r.get("detail") else "")
        for r in results
    ]
    return lines, any(r["status"] in FAILING for r in results)


def _run_phase(runtime, phase, checkpoint, random_file, env, log: Path) -> int:
    cmd = [
        "node",
        str(runtime.work_dir / "fwss-pay-upgrade.ts"),
        phase,
        str(checkpoint),
        str(random_file),
    ]
    with log.open("w") as stream:
        result = subprocess.run(
            cmd,
            cwd=str(runtime.work_dir),
            env={**os.environ, **env},
            stdout=stream,
            stderr=subprocess.STDOUT,
            timeout=PHASE_TIMEOUT_SECS,
        )
    info(f"Phase {phase} exited {result.returncode}; log: {log}")
    return result.returncode


def _upgrade(work: Path, devnet: dict, runtime_env: dict, evidence: Path) -> dict:
    """Runs fwss-pay-upgrade.sh; returns its reported values."""
    base_dir = Path(runtime_env["FOC_DEVNET_BASEDIR"])
    baseline_repo = base_dir / "code" / "filecoin-services"
    baseline_commit = subprocess.check_output(
        ["git", "-C", str(baseline_repo), "rev-parse", "HEAD"], text=True
    ).strip()
    baseline = work / "baseline"
    subprocess.run(
        ["git", "clone", "-q", "--no-checkout", str(baseline_repo), str(baseline)],
        check=True,
    )
    subprocess.run(
        ["git", "-C", str(baseline), "checkout", "-q", baseline_commit], check=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(baseline),
            "submodule",
            "update",
            "-q",
            "--init",
            "--recursive",
        ],
        check=True,
    )
    info(f"Baseline filecoin-services at {baseline_commit}")
    os.environ["FWSS_TRANSITION_SERVICES_REPO"] = os.environ["FWSS_PAY_SERVICES_REPO"]
    os.environ["FWSS_TRANSITION_CANDIDATE"] = os.environ["FWSS_PAY_CANDIDATE"]
    candidate = _candidate_checkout(work / "candidate-root")

    env = {
        **os.environ,
        "BASELINE_SERVICES_DIR": str(baseline / "service_contracts"),
        "CANDIDATE_SERVICES_DIR": str(candidate),
        "ETH_RPC_URL": runtime_env["RPC_URL"],
        "CHAIN": "31415926",
        "FWSS_PROXY_ADDRESS": devnet["contracts"]["fwss_service_proxy_addr"],
        "OWNER_PRIVATE_KEY": devnet["foc_deployer"]["private_key_hex"],
        "EVIDENCE_DIR": str(evidence),
        "UPGRADE_DELAY_EPOCHS": os.environ.get("FWSS_PAY_UPGRADE_DELAY_EPOCHS", "40"),
    }
    log = evidence / "upgrade.log"
    with log.open("w") as stream:
        result = subprocess.run(
            ["bash", str(UPGRADE_SCRIPT)],
            env=env,
            stdout=stream,
            stderr=subprocess.STDOUT,
            timeout=PHASE_TIMEOUT_SECS,
        )
    output = log.read_text()
    for deviation in re.findall(r"^CHECKLIST_DEVIATION=(.+)$", output, re.MULTILINE):
        info(f"Checklist deviation: {deviation}")
    if result.returncode != 0:
        fail(f"Upgrade failed (exit={result.returncode}); see {log}\n{output[-4000:]}")
    values = dict(
        re.findall(
            r"^(UPGRADE_BLOCK|FILECOIN_PAY_V2_ADDRESS)=(\S+)$", output, re.MULTILINE
        )
    )
    if set(values) != {"UPGRADE_BLOCK", "FILECOIN_PAY_V2_ADDRESS"}:
        fail(f"Upgrade did not report its block and FilecoinPayV2; see {log}")
    ok(
        f"FWSS upgraded at block {values['UPGRADE_BLOCK']}, FilecoinPayV2 {values['FILECOIN_PAY_V2_ADDRESS']}"
    )
    return values


def run():
    for tool in ("node", "forge", "cast", "jq", "uv", "make"):
        assert_ok(f"command -v {tool}", f"{tool} is installed")
    os.environ.setdefault("DEVNET_USER_INDEX", PAYER_INDEX)
    runtime_env = _lifecycle_environment()
    devnet = json.loads(Path(runtime_env["DEVNET_INFO_PATH"]).read_text())["info"]
    mode = choose_mode(devnet, os.environ)
    info(f"Mode: {mode}")

    evidence = Path(
        os.environ.get("FWSS_PAY_EVIDENCE_DIR")
        or tempfile.mkdtemp(prefix="fwss-pay-evidence-")
    )
    evidence.mkdir(parents=True, exist_ok=True)
    results_path = evidence / "pay-steps.json"
    results_path.unlink(missing_ok=True)
    info(f"Evidence directory: {evidence}")

    with tempfile.TemporaryDirectory(prefix="fwss-pay-") as tmp:
        work = Path(tmp)
        runtime = prepare_synapse_runtime(work / "runtime")
        random_file = runtime.work_dir / RAND_FILE_NAME
        write_random_file(random_file, RAND_FILE_SIZE, RAND_FILE_SEED)
        checkpoint = evidence / "checkpoint.json"
        env = {
            **runtime_env,
            "FWSS_PAY_RESULTS": str(results_path),
            "FWSS_PAY_PENDING": os.environ.get("FWSS_PAY_PENDING", ""),
        }
        crashed = []

        if mode == "v2":
            if _run_phase(
                runtime, "v2", checkpoint, random_file, env, evidence / "v2.log"
            ):
                crashed.append("v2")
        else:
            if _run_phase(
                runtime,
                "prepare",
                checkpoint,
                random_file,
                env,
                evidence / "prepare.log",
            ):
                crashed.append("prepare")
            if mode == "upgrade":
                values = _upgrade(work, devnet, runtime_env, evidence)
                env = {
                    **env,
                    "FWSS_UPGRADE_BLOCK": values["UPGRADE_BLOCK"],
                    "FILECOIN_PAY_V2_ADDRESS": values["FILECOIN_PAY_V2_ADDRESS"],
                }
                if _run_phase(
                    runtime,
                    "continue",
                    checkpoint,
                    random_file,
                    env,
                    evidence / "continue.log",
                ):
                    crashed.append("continue")

    results = json.loads(results_path.read_text()) if results_path.exists() else []
    lines, failed = summarize(results)
    info("FWSS Pay steps:\n" + "\n".join(lines))
    if failed or crashed or not results:
        fail(
            f"FWSS Pay failed (phases with errors: {crashed or 'none'}); see {evidence}"
        )
    ok(f"FWSS Pay steps passed ({len(results)} steps, mode {mode})")


if __name__ == "__main__":
    run()
