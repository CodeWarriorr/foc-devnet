#!/usr/bin/env python3
"""Require an actual ERC-8167 deployment, not merely a dispatcher in the source tree."""

import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scenarios.helpers import CAST, DEVNET_INFO

IMPLEMENTATION_SLOT = (
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
)


def cast(*args):
    result = subprocess.run(
        [CAST, *args], capture_output=True, text=True, timeout=30, check=True
    )
    return result.stdout.strip()


def decode_selectors(encoded):
    data = bytes.fromhex(encoded.removeprefix("0x"))
    if len(data) < 64 or int.from_bytes(data[:32], "big") != 32:
        raise ValueError("selectors() did not return an ABI bytes4 array")
    length = int.from_bytes(data[32:64], "big")
    if not length or len(data) != 64 + 32 * length:
        raise ValueError("selectors() returned an empty or malformed array")
    selectors = []
    for offset in range(64, len(data), 32):
        word = data[offset : offset + 32]
        if any(word[4:]):
            raise ValueError("selectors() contains invalid bytes4 padding")
        selectors.append("0x" + word[:4].hex())
    if len(set(selectors)) != len(selectors):
        raise ValueError("selectors() returned duplicates")
    return selectors


def canonical_type(argument):
    kind = argument["type"]
    if kind.startswith("tuple"):
        return (
            "(" + ",".join(map(canonical_type, argument["components"])) + ")" + kind[5:]
        )
    return kind


def required_signatures(abi):
    # Initial setup and migration have architecture-specific signatures. All other
    # legacy methods remain required unless the public contract is explicitly changed.
    return [
        item["name"] + "(" + ",".join(map(canonical_type, item["inputs"])) + ")"
        for item in abi
        if item.get("type") == "function"
        and item["name"] not in {"initialize", "migrate"}
    ]


def require_external_business_route(routes, business_selectors, implementation):
    if not any(
        routes[selector].lower() != implementation.lower()
        for selector in business_selectors
    ):
        raise ValueError("No baseline business method routes to an external module")


def run():
    abi_path = os.environ.get("FWSS_BASELINE_ABI")
    if not abi_path:
        raise ValueError("FWSS_BASELINE_ABI must name the baseline FWSS ABI")
    abi = json.loads(Path(abi_path).read_text())
    signatures = required_signatures(abi)
    if not signatures:
        raise ValueError("Baseline ABI contains no required methods")
    info = json.loads(Path(DEVNET_INFO).read_text())["info"]
    rpc = info["lotus"]["host_rpc_url"]
    if cast("chain-id", "--rpc-url", rpc) != "31415926":
        raise ValueError("Dispatch regression is restricted to the local DevNet")
    contracts = info["contracts"]
    proxy = contracts["fwss_service_proxy_addr"]
    storage = cast("storage", proxy, IMPLEMENTATION_SLOT, "--rpc-url", rpc)
    implementation = "0x" + storage[-40:]
    if implementation.lower() != contracts["fwss_impl_addr"].lower():
        raise ValueError("Live implementation differs from the recorded deployment")
    calldata = cast("calldata", "selectors()")
    encoded = cast("call", proxy, "--data", calldata, "--rpc-url", rpc)
    selectors = decode_selectors(encoded)
    baseline_selectors = {s: cast("sig", s) for s in signatures}
    missing = [
        s for s, selector in baseline_selectors.items() if selector not in selectors
    ]
    if missing:
        raise ValueError(f"Dispatcher is missing baseline methods: {missing}")
    routes = {}
    code_hashes = {}
    for selector in selectors:
        address = cast(
            "call", proxy, "implementation(bytes4)(address)", selector, "--rpc-url", rpc
        )
        if int(address, 16) == 0:
            raise ValueError(f"Selector {selector} has no delegate")
        address = address.lower()
        if address not in code_hashes:
            code = cast("code", address, "--rpc-url", rpc)
            if code == "0x":
                raise ValueError(f"Delegate {address} has no runtime code")
            code_hashes[address] = cast("keccak", code)
        routes[selector] = address
    require_external_business_route(
        routes,
        [
            selector
            for signature, selector in baseline_selectors.items()
            if signature.startswith("terminateService(")
        ],
        implementation,
    )
    result = {
        "proxy": proxy,
        "implementation": implementation,
        "routes": routes,
        "runtime_hashes": code_hashes,
        "required_methods": signatures,
    }
    output = os.environ.get("FWSS_DISPATCH_REPORT")
    if output:
        Path(output).write_text(json.dumps(result, indent=2) + "\n")
    print(f"Verified ERC-8167 routing for {len(selectors)} selectors on {proxy}")


if __name__ == "__main__":
    try:
        run()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"FAIL: FWSS dispatcher verification: {error}", file=sys.stderr)
        sys.exit(1)
