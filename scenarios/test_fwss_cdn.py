#!/usr/bin/env python3
"""Opt-in FWSS FilBeam CDN service, termination, and post-termination payment scenario."""

import os, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import tempfile
from pathlib import Path

from scenarios.helpers import assert_ok, info, write_random_file
from scenarios.synapse_runtime import prepare_synapse_runtime, run_node_script
from scenarios.test_fwss_lifecycle import _lifecycle_environment

RAND_FILE_NAME = "fwss_cdn_file"
RAND_FILE_SIZE = 2 * 1024 * 1024
RAND_FILE_SEED = 8169
# USER_2: the lifecycle owns USER_1 and the proving scenario USER_3.
CDN_USER_INDEX = "1"
# Two proving periods plus data set creation.
SCENARIO_TIMEOUT_SECS = 2400


def _cdn_environment() -> dict[str, str]:
    os.environ.setdefault("DEVNET_USER_INDEX", CDN_USER_INDEX)
    env = _lifecycle_environment()
    devnet = json.loads(Path(env["DEVNET_INFO_PATH"]).read_text())["info"]
    providers = [sp for sp in devnet["pdp_sps"] if sp["is_approved"]]
    if not providers:
        raise ValueError("devnet-info.json lists no approved PDP provider")
    if "foc_deployer" not in devnet:
        raise ValueError(
            "devnet-info.json exports no foc_deployer, the FilBeam controller"
        )
    env["FWSS_PROVIDER_ID"] = str(providers[0]["provider_id"])
    env["FWSS_PROOF_TIMEOUT_MS"] = os.environ.get("FWSS_PROOF_TIMEOUT_MS", "1200000")
    return env


def run():
    assert_ok("command -v node", "node is installed")
    runtime_env = _cdn_environment()

    with tempfile.TemporaryDirectory(prefix="fwss-cdn-") as tmp:
        runtime = prepare_synapse_runtime(Path(tmp))
        random_file = runtime.work_dir / RAND_FILE_NAME
        info(f"Creating deterministic CDN file ({RAND_FILE_SIZE} bytes)")
        write_random_file(random_file, RAND_FILE_SIZE, RAND_FILE_SEED)

        info("Running FWSS CDN service and termination scenario against devnet")
        run_node_script(
            runtime,
            "fwss-cdn.ts",
            "FWSS CDN service and termination",
            args=[str(random_file)],
            env=runtime_env,
            timeout=SCENARIO_TIMEOUT_SECS,
            retry_state_forks=False,
        )


if __name__ == "__main__":
    run()
