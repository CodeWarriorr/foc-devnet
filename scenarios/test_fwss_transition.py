#!/usr/bin/env python3
"""Opt-in rehearsal of the one-time v1.4.0 -> ERC-8167 dispatcher transition.

Runs on a devnet that deployed the v1.4.0 monolith. Prepares state on it,
transitions the same proxy with the candidate's UPGRADE-CHECKLIST.md commands,
then checks the state and its continued service. Remove this scenario,
fwss-transition-upgrade.sh and synapse-e2e/fwss-transition.ts once Calibnet and
Mainnet run the dispatcher.

Required environment:
  FWSS_TRANSITION_SERVICES_REPO  local filecoin-services repository
  FWSS_TRANSITION_CANDIDATE      committed ref to transition to
Optional:
  FWSS_TRANSITION_EVIDENCE_DIR   where to keep logs and ledgers (default: a new temp dir)
"""

import os, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import re
import shlex
import subprocess
import tempfile
from pathlib import Path

from scenarios.helpers import assert_ok, fail, info, ok, write_random_file
from scenarios.synapse_runtime import prepare_synapse_runtime, run_node_script
from scenarios.test_fwss_lifecycle import _lifecycle_environment

RAND_FILE_NAME = "fwss_transition_file"
RAND_FILE_SIZE = 2 * 1024 * 1024
RAND_FILE_SEED = 8169
PHASE_TIMEOUT_SECS = 3600
UPGRADE_SCRIPT = Path(__file__).resolve().parent / "fwss-transition-upgrade.sh"


def _candidate_checkout(work: Path) -> Path:
    repo = Path(os.environ["FWSS_TRANSITION_SERVICES_REPO"]).resolve()
    ref = os.environ["FWSS_TRANSITION_CANDIDATE"]
    commit = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "--verify", f"{ref}^{{commit}}"],
        text=True,
    ).strip()
    checkout = work / "filecoin-services"
    subprocess.run(
        ["git", "clone", "-q", "--no-checkout", str(repo), str(checkout)], check=True
    )
    subprocess.run(["git", "-C", str(checkout), "checkout", "-q", commit], check=True)
    # Relative submodule URLs resolve against the local clone, so use the upstream ones.
    subprocess.run(
        [
            "git",
            "-C",
            str(checkout),
            "submodule",
            "update",
            "-q",
            "--init",
            "--recursive",
        ],
        check=True,
    )
    info(f"Candidate filecoin-services {ref} at {commit}")
    return checkout / "service_contracts"


def run():
    for tool in ("node", "forge", "cast", "jq", "uv", "make"):
        assert_ok(f"command -v {tool}", f"{tool} is installed")
    for name in ("FWSS_TRANSITION_SERVICES_REPO", "FWSS_TRANSITION_CANDIDATE"):
        if not os.environ.get(name):
            fail(f"{name} is required")
            return

    runtime_env = _lifecycle_environment()
    info_path = Path(runtime_env["DEVNET_INFO_PATH"])
    devnet = json.loads(info_path.read_text())["info"]
    base_dir = Path(runtime_env["FOC_DEVNET_BASEDIR"])
    state_view_abi = (
        base_dir
        / "code/filecoin-services/service_contracts/abi/FilecoinWarmStorageServiceStateView.abi.json"
    )
    if not state_view_abi.is_file():
        fail(f"{state_view_abi} not found; the devnet must run the v1.4.0 monolith")
        return
    # The transition is one-time: a devnet that already ran it has nothing to transition.
    proxy = devnet["contracts"]["fwss_service_proxy_addr"]
    implementation = subprocess.check_output(
        ["cast", "implementation", "--rpc-url", runtime_env["RPC_URL"], proxy],
        text=True,
    ).strip()
    if implementation.lower() != devnet["contracts"]["fwss_impl_addr"].lower():
        fail(
            f"FWSS proxy {proxy} no longer runs the deployed v1.4.0 implementation; start a new devnet"
        )
        return
    evidence = Path(
        os.environ.get("FWSS_TRANSITION_EVIDENCE_DIR")
        or tempfile.mkdtemp(prefix="fwss-evidence-")
    )
    evidence.mkdir(parents=True, exist_ok=True)
    info(f"Evidence directory: {evidence}")

    with tempfile.TemporaryDirectory(prefix="fwss-transition-") as tmp:
        work = Path(tmp)
        services = _candidate_checkout(work)
        runtime = prepare_synapse_runtime(work / "runtime")
        random_file = runtime.work_dir / RAND_FILE_NAME
        write_random_file(random_file, RAND_FILE_SIZE, RAND_FILE_SEED)
        checkpoint = evidence / "checkpoint.json"
        scenario_env = {**runtime_env, "FWSS_STATE_VIEW_ABI": str(state_view_abi)}

        info("Phase 1: prepare state on the v1.4.0 monolith")
        run_node_script(
            runtime,
            "fwss-transition.ts",
            "FWSS transition: prepare",
            args=["prepare", str(checkpoint), str(random_file)],
            env=scenario_env,
            timeout=PHASE_TIMEOUT_SECS,
            retry_state_forks=False,
        )

        info("Phase 2: transition with the UPGRADE-CHECKLIST.md commands")
        arm = " ".join(
            shlex.quote(part)
            for part in [
                "node",
                str(runtime.work_dir / "fwss-transition.ts"),
                "arm",
                str(checkpoint),
                str(random_file),
            ]
        )
        upgrade_env = {
            **os.environ,
            **scenario_env,
            "SERVICES_DIR": str(services),
            "ETH_RPC_URL": runtime_env["RPC_URL"],
            "CHAIN": "31415926",
            "FWSS_PROXY_ADDRESS": proxy,
            "OWNER_PRIVATE_KEY": devnet["foc_deployer"]["private_key_hex"],
            "EVIDENCE_DIR": str(evidence),
            "PRE_EXECUTE_HOOK": f"cd {shlex.quote(str(runtime.work_dir))} && {arm}",
        }
        log = evidence / "upgrade.log"
        with log.open("w") as stream:
            result = subprocess.run(
                ["bash", str(UPGRADE_SCRIPT)],
                env=upgrade_env,
                stdout=stream,
                stderr=subprocess.STDOUT,
                timeout=PHASE_TIMEOUT_SECS,
            )
        output = log.read_text()
        if result.returncode != 0:
            fail(
                f"Checklist transition failed (exit={result.returncode}); see {log}\n{output[-4000:]}"
            )
            return
        match = re.search(r"^TRANSITION_BLOCK=(\d+)$", output, re.MULTILINE)
        if not match:
            fail(f"Transition block not reported; see {log}")
            return
        ok(f"Transition executed at block {match.group(1)}")
        for deviation in re.findall(
            r"^CHECKLIST_DEVIATION=(.+)$", output, re.MULTILINE
        ):
            info(f"Checklist deviation: {deviation}")

        info("Phase 3: continue on the dispatcher")
        run_node_script(
            runtime,
            "fwss-transition.ts",
            "FWSS transition: continue",
            args=["continue", str(checkpoint), str(random_file)],
            env={
                **scenario_env,
                "FWSS_TRANSITION_BLOCK": match.group(1),
                "FWSS_GAS_REPORT": str(evidence / "proving-gas.json"),
            },
            timeout=PHASE_TIMEOUT_SECS,
            retry_state_forks=False,
        )


if __name__ == "__main__":
    run()
