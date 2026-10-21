#!/usr/bin/env python3
"""Opt-in FWSS missed-proof settlement and piece deletion scenario."""

import os, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import tempfile
from pathlib import Path

from scenarios.helpers import assert_ok, info, write_random_file
from scenarios.synapse_runtime import prepare_synapse_runtime, run_node_script
from scenarios.test_fwss_lifecycle import _lifecycle_environment

RAND_FILE_NAME = "fwss_proving_file"
RAND_FILE_SIZE = 4 * 1024 * 1024
RAND_FILE_SEED = 8168
# USER_1 and USER_2 belong to the other scenarios.
PROVING_USER_INDEX = "2"
# Four proving periods and the piece-removal boundary after them.
SCENARIO_TIMEOUT_SECS = 3600


def _proving_environment() -> dict[str, str]:
    os.environ.setdefault("DEVNET_USER_INDEX", PROVING_USER_INDEX)
    env = _lifecycle_environment()
    devnet = json.loads(Path(env["DEVNET_INFO_PATH"]).read_text())["info"]
    providers = [sp for sp in devnet["pdp_sps"] if sp["is_approved"]]
    if not providers:
        raise ValueError("devnet-info.json lists no approved PDP provider")
    # The scenario pauses this provider's Curio, so pick one container to own.
    provider = providers[-1]
    env["FWSS_PROVIDER_ID"] = str(provider["provider_id"])
    env["FWSS_PROVIDER_CONTAINER"] = provider["container_name"]
    env["FWSS_PROOF_TIMEOUT_MS"] = os.environ.get("FWSS_PROOF_TIMEOUT_MS", "1200000")
    return env


def run():
    assert_ok("command -v node", "node is installed")
    assert_ok("command -v docker", "docker is installed")
    runtime_env = _proving_environment()

    with tempfile.TemporaryDirectory(prefix="fwss-proving-") as tmp:
        runtime = prepare_synapse_runtime(Path(tmp))
        random_file = runtime.work_dir / RAND_FILE_NAME
        info(f"Creating deterministic proving file ({RAND_FILE_SIZE} bytes)")
        write_random_file(random_file, RAND_FILE_SIZE, RAND_FILE_SEED)

        info("Running FWSS missed-proof and deletion scenario against devnet")
        run_node_script(
            runtime,
            "fwss-proving.ts",
            "FWSS proving, missed period, and piece deletion",
            args=[str(random_file)],
            env=runtime_env,
            timeout=SCENARIO_TIMEOUT_SECS,
            retry_state_forks=False,
        )


if __name__ == "__main__":
    run()
