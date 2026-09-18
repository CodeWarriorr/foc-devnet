#!/usr/bin/env python3
"""Opt-in FWSS upload, proof, settlement, and termination regression."""

import os, sys  # noqa: E401

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json
import tempfile
from pathlib import Path

from scenarios.helpers import assert_eq, assert_ok, info, write_random_file
from scenarios.synapse_runtime import prepare_synapse_runtime, run_node_script

RAND_FILE_NAME = "fwss_lifecycle_file"
RAND_FILE_SIZE = 20 * 1024 * 1024
RAND_FILE_SEED = 8167
SCENARIO_TIMEOUT_SECS = 1200


def _lifecycle_environment() -> dict[str, str]:
    base_dir = Path(
        os.environ.get("FOC_DEVNET_BASEDIR", Path.home() / ".foc-devnet")
    ).resolve()
    info_path = base_dir / "state" / "latest" / "devnet-info.json"
    document = json.loads(info_path.read_text())
    devnet = document["info"]
    user_index = int(os.environ.get("DEVNET_USER_INDEX", "0"))
    users = devnet["users"]
    if user_index < 0 or user_index >= len(users):
        raise ValueError(f"DEVNET_USER_INDEX {user_index} is out of range")

    rpc_url = devnet["lotus"]["host_rpc_url"]
    private_key = users[user_index]["private_key_hex"]
    if not isinstance(rpc_url, str) or not rpc_url:
        raise ValueError("devnet-info.json has no Lotus host RPC URL")
    if not isinstance(private_key, str) or not private_key.startswith("0x"):
        raise ValueError("selected devnet user has no 0x-prefixed private key")

    return {
        "NETWORK": "devnet",
        "FOC_DEVNET_BASEDIR": str(base_dir),
        "DEVNET_INFO_PATH": str(info_path),
        "DEVNET_USER_INDEX": str(user_index),
        "RPC_URL": rpc_url,
        "PRIVATE_KEY": private_key,
    }


def run():
    assert_ok("command -v node", "node is installed")
    runtime_env = _lifecycle_environment()

    with tempfile.TemporaryDirectory(prefix="fwss-lifecycle-") as tmp:
        runtime = prepare_synapse_runtime(Path(tmp))
        random_file = runtime.work_dir / RAND_FILE_NAME
        info(f"Creating deterministic lifecycle file ({RAND_FILE_SIZE} bytes)")
        write_random_file(random_file, RAND_FILE_SIZE, RAND_FILE_SEED)
        assert_eq(
            random_file.stat().st_size,
            RAND_FILE_SIZE,
            f"{RAND_FILE_NAME} created with exact size {RAND_FILE_SIZE} bytes",
        )

        info("Running strict FWSS lifecycle regression against devnet")
        run_node_script(
            runtime,
            "fwss-lifecycle.ts",
            "FWSS business lifecycle regression",
            args=[str(random_file)],
            env=runtime_env,
            timeout=SCENARIO_TIMEOUT_SECS,
            retry_state_forks=False,
        )


if __name__ == "__main__":
    run()
