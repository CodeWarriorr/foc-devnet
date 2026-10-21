#!/usr/bin/env bash
# Runs Procedure A of filecoin-services' tools/UPGRADE-CHECKLIST.md (the one-time
# v1.4.0 monolith -> ERC-8167 dispatcher transition) against a devnet, with the
# checklist's own commands. Lines marked "DEVNET:" are the only departures, each
# with its reason. Remove this file with test_fwss_transition.py once Calibnet
# and Mainnet run the dispatcher.
#
# Required environment:
#   SERVICES_DIR        candidate filecoin-services service_contracts/ checkout
#   ETH_RPC_URL, CHAIN, FWSS_PROXY_ADDRESS
#   OWNER_PRIVATE_KEY   devnet key of the FWSS owner
#   EVIDENCE_DIR        where logs, broadcasts and ledgers are kept
# Optional:
#   UPGRADE_DELAY_EPOCHS (default 40)
#   PRE_EXECUTE_HOOK    command run right before A4, to leave changes pending across it
set -euo pipefail

: "${SERVICES_DIR:?}" "${ETH_RPC_URL:?}" "${CHAIN:?}" "${FWSS_PROXY_ADDRESS:?}" "${OWNER_PRIVATE_KEY:?}" "${EVIDENCE_DIR:?}"
UPGRADE_DELAY_EPOCHS="${UPGRADE_DELAY_EPOCHS:-40}"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_DIR="$(cd "$EVIDENCE_DIR" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$SERVICES_DIR"

step() { printf '\n=== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# A rejection counts only with the expected reason; an RPC or build error fails too.
expect_rejection() { grep -q -- "$2" "$1" || { cat "$1" >&2; fail "$3"; }; }
evidence() { printf '%s\n' "$@" >> "$EVIDENCE_DIR/rollout-evidence.md"; }

# DEVNET: the checklist installs josuke and evm into the operator's PATH. Install
# the same pinned revisions with the Makefile targets, into this run only.
step "Install the pinned josuke and evm"
mkdir -p "$WORK/bin"
make install-evm EVM_INSTALL_DIR="$WORK/bin" >/dev/null
UV_TOOL_DIR="$WORK/uv" UV_TOOL_BIN_DIR="$WORK/bin" make install-josuke >/dev/null
export PATH="$WORK/bin:$PATH"

# DEVNET: Calibnet and Mainnet sign with the operator's keystore. Build one from
# the devnet owner key so every command can take the checklist's flags.
cast wallet import --keystore-dir "$WORK/keystores" owner \
  --private-key "$OWNER_PRIVATE_KEY" --unsafe-password devnet >/dev/null
KEYSTORE="$WORK/keystores/owner"
printf 'devnet' > "$WORK/password"
PASSWORD_FILE="$WORK/password"
OWNER="$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")"

read_plan() {
  local word
  word=$(cast storage --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 19)
  PLANNED_TARGET=$(cast to-check-sum-address "0x${word:26:40}")
  PLANNED_AFTER_EPOCH=$(cast to-dec "0x${word:2:24}")
  echo "Pending target: $PLANNED_TARGET, afterEpoch: $PLANNED_AFTER_EPOCH"
}

head_epoch() { cast block-number --rpc-url "$ETH_RPC_URL"; }

# Summarizes the gas forge requested and the gas each transaction used.
gas_table() {
  python3 - "$1" <<'EOF'
import json, sys
run = json.load(open(sys.argv[1]))
receipts = {r["transactionHash"]: r for r in run.get("receipts", [])}
print("| Contract | Type | Gas limit | Gas used | Status |")
print("|---|---|---:|---:|---|")
for tx in run.get("transactions", []):
    receipt = receipts.get(tx.get("hash")) or {}
    limit = int(tx["transaction"].get("gas", "0x0"), 16)
    used = int(receipt.get("gasUsed", "0x0"), 16) if receipt else 0
    status = {"0x1": "success", "0x0": "reverted"}.get(receipt.get("status"), "no receipt")
    print(f"| {tx.get('contractName') or tx.get('function') or '-'} | {tx.get('transactionType')} | {limit} | {used} | {status} |")
EOF
}

# Runs a broadcast exactly as the checklist writes it, and only if that fails,
# again with --skip-simulation as warm-storage-deploy-all.sh does. Both results
# and their gas go to the evidence file.
broadcast_script() {
  local label="$1" script="$2"; shift 2
  local name broadcast_json
  name="$(basename "$script")"
  broadcast_json="broadcast/$name/$CHAIN/run-latest.json"
  evidence "" "### $label" ""
  if "$@" --broadcast 2>&1 | tee "$EVIDENCE_DIR/$label-checklist.log"; then
    evidence "As in the checklist (no --skip-simulation): **success**" ""
    [ -f "$broadcast_json" ] && cp "$broadcast_json" "$EVIDENCE_DIR/$label-checklist.json" \
      && gas_table "$broadcast_json" >> "$EVIDENCE_DIR/rollout-evidence.md"
    return 0
  fi
  evidence "As in the checklist (no --skip-simulation): **failed**, see \`$label-checklist.log\`" ""
  echo "CHECKLIST_DEVIATION=$label needed --skip-simulation"
  [ -f "$broadcast_json" ] && cp "$broadcast_json" "$EVIDENCE_DIR/$label-checklist.json" \
    && gas_table "$broadcast_json" >> "$EVIDENCE_DIR/rollout-evidence.md"
  if "$@" --broadcast --skip-simulation 2>&1 | tee "$EVIDENCE_DIR/$label-skip-simulation.log"; then
    evidence "" "With --skip-simulation: **success**" ""
  else
    evidence "" "With --skip-simulation: **failed**, see \`$label-skip-simulation.log\`" ""
    [ -f "$broadcast_json" ] && gas_table "$broadcast_json" >> "$EVIDENCE_DIR/rollout-evidence.md"
    fail "$label failed with and without --skip-simulation"
  fi
  cp "$broadcast_json" "$EVIDENCE_DIR/$label-skip-simulation.json"
  gas_table "$broadcast_json" >> "$EVIDENCE_DIR/rollout-evidence.md"
}

evidence "# FWSS dispatcher transition rehearsal on devnet" "" \
  "Candidate: \`$(git rev-parse HEAD)\`, chain $CHAIN, proxy \`$FWSS_PROXY_ADDRESS\`, owner \`$OWNER\`" ""

step "Choose the Upgrade Path"
IMPL=$(cast implementation --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS")
IMPL_CODEHASH=$(cast keccak "$(cast code --rpc-url "$ETH_RPC_URL" "$IMPL")")
PINNED_DISPATCHER_CODEHASH=$(grep -o '0x[0-9a-f]\{64\}' <<< "$(grep 'FWSS_DISPATCHER_CODE_HASH =' src/FWSSDispatcherTransition.sol)")
echo "Implementation $IMPL, code hash $IMPL_CODEHASH"
[ "$IMPL_CODEHASH" != "$PINNED_DISPATCHER_CODEHASH" ] || fail "the proxy already runs the dispatcher (Path B)"
echo "Path A: monolith installed"
MONOLITH="$IMPL"

# DEVNET: Calibnet and Mainnet entries for the v1.4.0 proxy are committed in
# josuke.json. Record this devnet's proxy the same way, from its own getters.
step "Record the devnet v1.4.0 proxy in josuke.json"
dependency() { cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" "$1()(address)"; }
jq --indent 4 \
  --arg proxy "$(cast to-check-sum-address "$FWSS_PROXY_ADDRESS")" --arg chain "$CHAIN" \
  --arg pay "$(dependency paymentsContractAddress)" --arg pdp "$(dependency pdpVerifierAddress)" \
  --arg usdfc "$(dependency usdfcTokenAddress)" --arg beneficiary "$(dependency filBeamBeneficiaryAddress)" \
  --arg registry "$(dependency serviceProviderRegistry)" --arg sessions "$(dependency sessionKeyRegistry)" '
  . + [{
    address: $proxy,
    facetSrc: (map(select(.deployments["314159"] != null)) | first | .facetSrc),
    deployments: {($chain): {
      constructorArgs: {
        _paymentsContractAddress: $pay, _pdpVerifierAddress: $pdp, _usdfc: $usdfc,
        _filBeamBeneficiaryAddress: $beneficiary, _serviceProviderRegistry: $registry,
        _sessionKeyRegistry: $sessions
      },
      legacy: (map(select(.deployments["314159"] != null)) | first | .deployments["314159"].legacy)
    }}
  }]' josuke.json > "$WORK/josuke.json"
mv "$WORK/josuke.json" josuke.json

step "Prerequisite: make erc8167"
make erc8167

step "A1: Deploy"
broadcast_script "A1-dispatcher-deploy" script/FWSSDispatcherDeploy.s.sol \
  forge script script/FWSSDispatcherDeploy.s.sol \
  --rpc-url "$ETH_RPC_URL" --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE"
export DISPATCHER=$(jq -r ".\"$CHAIN\".FWSS_DISPATCHER_ADDRESS" deployments.json)
(source tools/josuke.sh; josuke_move_entry "$FWSS_PROXY_ADDRESS" "$DISPATCHER")

evidence "" "### A1-josuke-deploy" ""
if ETH_KEYSTORE="$KEYSTORE" ETH_PASSWORD="$PASSWORD_FILE" josuke deploy 2>&1 | tee "$EVIDENCE_DIR/A1-josuke-deploy.log"; then
  evidence "\`josuke deploy\`: **success**"
else
  evidence "\`josuke deploy\`: **failed**, see \`A1-josuke-deploy.log\`"
  fail "josuke deploy failed"
fi
josuke verify 2>&1 | tee "$EVIDENCE_DIR/A1-josuke-verify.log"

# DEVNET: no Blockscout, so --verify --verifier blockscout is left out.
broadcast_script "A1-transition-deploy" script/FWSSDispatcherTransitionDeploy.s.sol \
  env GIT_COMMIT="$(git rev-parse HEAD)" forge script script/FWSSDispatcherTransitionDeploy.s.sol \
  --rpc-url "$ETH_RPC_URL" --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE"

./tools/verify-deployments.sh --chain "$CHAIN" --eth-call 2>&1 | tee "$EVIDENCE_DIR/A1-verify-deployments.log"
# The ledgers as the A1 scripts left them, for running the filecoin-services tests against.
cp deployments.json "$EVIDENCE_DIR/A1-deployments.json"
cp josuke.json "$EVIDENCE_DIR/A1-josuke.json"

step "A2: Announce"
export DISPATCHER=$(jq -r ".\"$CHAIN\".FWSS_DISPATCHER_ADDRESS" deployments.json)
export TRANSITION=$(jq -r ".\"$CHAIN\".FWSS_DISPATCHER_TRANSITION_ADDRESS" deployments.json)
export NEW_FWSS_IMPLEMENTATION_ADDRESS="$TRANSITION"
export UPGRADE_DELAY_EPOCHS
CALLDATA_ONLY=true ./tools/warm-storage-announce-upgrade.sh
CALLDATA=$(cast calldata 'announceUpgradePlan(address,uint96)' "$TRANSITION" "$UPGRADE_DELAY_EPOCHS")
cast 4byte-calldata "$CALLDATA"
# DEVNET: the owner is an EOA, not a Safe, so the announce script sends the
# transaction itself instead of a signer submitting $CALLDATA.
BEFORE=$(head_epoch)
# DEVNET: with ETH_KEYSTORE exported, cast 1.7.1 also unlocks the keystore for
# the script's `cast call`s, and without a TTY only ETH_PASSWORD can answer it.
ETH_KEYSTORE="$KEYSTORE" ETH_PASSWORD="$PASSWORD_FILE" PASSWORD=devnet ./tools/warm-storage-announce-upgrade.sh
AFTER=$(head_epoch)
read_plan
[ "$PLANNED_TARGET" = "$(cast to-check-sum-address "$TRANSITION")" ] || fail "pending target is not the transition"
ANNOUNCED_AT=$((PLANNED_AFTER_EPOCH - UPGRADE_DELAY_EPOCHS))
[ "$ANNOUNCED_AT" -ge "$BEFORE" ] && [ "$ANNOUNCED_AT" -le "$AFTER" ] \
  || fail "afterEpoch $PLANNED_AFTER_EPOCH is not the announce block plus $UPGRADE_DELAY_EPOCHS"

# Before A3: josuke verify can outlast the delay.
step "Execute before afterEpoch must fail"
[ "$(head_epoch)" -lt "$PLANNED_AFTER_EPOCH" ] || fail "the delay passed before the early execute attempt; raise UPGRADE_DELAY_EPOCHS"
if FWSS_DISPATCHER_TRANSITION_ADDRESS="$TRANSITION" CALLDATA_ONLY=true \
  forge script script/FWSSDispatcherTransitionExecute.s.sol --rpc-url "$ETH_RPC_URL" > "$EVIDENCE_DIR/early-execute-script.log" 2>&1; then
  fail "the execute script accepted a plan before afterEpoch"
fi
expect_rejection "$EVIDENCE_DIR/early-execute-script.log" "not time yet" "the execute script failed for a reason other than the delay"
# The proxy itself must refuse, not only the script.
EARLY_UPGRADE=$(cast calldata 'upgradeToAndCall(address,bytes)' "$TRANSITION" "$(cast calldata 'migrate(address)' "$(cast call --rpc-url "$ETH_RPC_URL" "$TRANSITION" 'migration()(address)')")")
if cast call --rpc-url "$ETH_RPC_URL" --from "$OWNER" "$FWSS_PROXY_ADDRESS" "$EARLY_UPGRADE" > "$EVIDENCE_DIR/early-execute-call.log" 2>&1; then
  fail "the proxy accepted upgradeToAndCall before afterEpoch"
fi
# v1.4.0 checks afterEpoch with a bare require, so the revert has no data.
expect_rejection "$EVIDENCE_DIR/early-execute-call.log" 'data: "0x"$' "upgradeToAndCall failed for a reason other than a bare revert"
echo "Early execute rejected by the script and by the proxy"

step "A3: Review During the Delay"
read_plan
[ "$PLANNED_TARGET" = "$(cast to-check-sum-address "$TRANSITION")" ] || fail "pending target changed"
PINNED_MIGRATION=$(cast call --rpc-url "$ETH_RPC_URL" "$TRANSITION" 'migration()(address)')
PINNED_DISPATCHER=$(cast call --rpc-url "$ETH_RPC_URL" "$TRANSITION" 'dispatcher()(address)')
check_pin() { echo "$1: $2 (expected $3)"; [ "$(tr 'A-F' 'a-f' <<< "$2")" = "$(tr 'A-F' 'a-f' <<< "$3")" ] || fail "$1 pin differs"; }
check_pin previousImplementation "$(cast call --rpc-url "$ETH_RPC_URL" "$TRANSITION" 'previousImplementation()(address)')" "$(cast implementation --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS")"
check_pin migration "$PINNED_MIGRATION" "$(source tools/josuke.sh; josuke_proposed_migration "$DISPATCHER")"
check_pin dispatcher "$PINNED_DISPATCHER" "$DISPATCHER"
check_pin migrationCodeHash "$(cast call --rpc-url "$ETH_RPC_URL" "$TRANSITION" 'migrationCodeHash()(bytes32)')" "$(cast keccak "$(cast code --rpc-url "$ETH_RPC_URL" "$PINNED_MIGRATION")")"
check_pin "dispatcher code hash" "$(cast keccak "$(cast code --rpc-url "$ETH_RPC_URL" "$PINNED_DISPATCHER")")" "$PINNED_DISPATCHER_CODEHASH"
josuke verify

step "Wait for afterEpoch $PLANNED_AFTER_EPOCH"
until [ "$(head_epoch)" -ge "$PLANNED_AFTER_EPOCH" ]; do sleep 4; done

if [ -n "${PRE_EXECUTE_HOOK:-}" ]; then
  step "Pre-execute hook"
  bash -c "$PRE_EXECUTE_HOOK"
fi

step "A4: Execute"
export FWSS_DISPATCHER_TRANSITION_ADDRESS="$TRANSITION"
CALLDATA_ONLY=true forge script script/FWSSDispatcherTransitionExecute.s.sol --rpc-url "$ETH_RPC_URL" \
  2>&1 | tee "$EVIDENCE_DIR/A4-calldata.log"
CALLDATA=$(grep -oE '0x[0-9a-fA-F]{200,}' "$EVIDENCE_DIR/A4-calldata.log" | tail -1)
[ -n "$CALLDATA" ] || fail "the execute script printed no calldata"
[ "$(cast calldata-decode 'upgradeToAndCall(address,bytes)' "$CALLDATA" | sed -n 1p)" = "$(cast to-check-sum-address "$TRANSITION")" ] \
  || fail "calldata does not upgrade to the transition"
INNER=$(cast calldata-decode 'upgradeToAndCall(address,bytes)' "$CALLDATA" | sed -n 2p)
[ "$(cast calldata-decode 'migrate(address)' "$INNER")" = "$(cast to-check-sum-address "$PINNED_MIGRATION")" ] \
  || fail "inner migrate does not name the pinned migration"
# DEVNET: no Safe; the execute script sends the same upgrade as the owner.
broadcast_script "A4-execute" script/FWSSDispatcherTransitionExecute.s.sol \
  forge script script/FWSSDispatcherTransitionExecute.s.sol \
  --rpc-url "$ETH_RPC_URL" --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE" --sender "$OWNER"

TRANSITION_BLOCK=$(cast to-dec "$(jq -r '.receipts[-1].blockNumber' "broadcast/FWSSDispatcherTransitionExecute.s.sol/$CHAIN/run-latest.json")")
echo "TRANSITION_BLOCK=$TRANSITION_BLOCK"

step "A5: List the Proxy in the Ledger Again"
(source tools/josuke.sh; josuke_move_entry "$DISPATCHER" "$FWSS_PROXY_ADDRESS")

step "Post-Upgrade Checks"
IMPL=$(cast implementation --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS")
IMPL_CODEHASH=$(cast keccak "$(cast code --rpc-url "$ETH_RPC_URL" "$IMPL")")
echo "Implementation: $IMPL, code hash $IMPL_CODEHASH (expected $PINNED_DISPATCHER_CODEHASH)"
[ "$IMPL_CODEHASH" = "$PINNED_DISPATCHER_CODEHASH" ] || fail "the proxy does not run the pinned dispatcher"
read_plan
[ "$PLANNED_AFTER_EPOCH" = "0" ] && [ "$PLANNED_TARGET" = "0x0000000000000000000000000000000000000000" ] || fail "slot 19 is not cleared"
check_pin owner "$(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'owner()(address)')" "$OWNER"
echo "VERSION(): $(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'VERSION()(string)')"
for sig in 'announceMigration(address,uint96)' 'migrate(address)' 'implementation(bytes4)' 'selectors()'; do
  route=$(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'implementation(bytes4)(address)' "$(cast sig "$sig")")
  echo "$sig -> $route"
  [ "$route" != "0x0000000000000000000000000000000000000000" ] || fail "$sig has no route"
done
josuke accept 2>&1 | tee "$EVIDENCE_DIR/josuke-accept.log"
cp deployments.json "$EVIDENCE_DIR/final-deployments.json"
cp josuke.json "$EVIDENCE_DIR/final-josuke.json"

step "Recovery is closed after a completed transition"
if cast call --rpc-url "$ETH_RPC_URL" --from "$OWNER" "$FWSS_PROXY_ADDRESS" 'abortTransition()' > "$EVIDENCE_DIR/abort-after.log" 2>&1; then
  fail "abortTransition succeeded after a completed transition"
fi
# FunctionNotFound(abortTransition()): the dispatcher no longer routes it.
expect_rejection "$EVIDENCE_DIR/abort-after.log" "0x5416eb98aeccc0ad" "abortTransition failed for a reason other than a missing route"
STRANGER=$(cast wallet address --private-key 0x0000000000000000000000000000000000000000000000000000000000000001)
if cast call --rpc-url "$ETH_RPC_URL" --from "$STRANGER" "$FWSS_PROXY_ADDRESS" \
  'announceMigration(address,uint96)' "$PINNED_MIGRATION" 1 > "$EVIDENCE_DIR/stranger-announce.log" 2>&1; then
  fail "a non-owner could announce a migration"
fi
expect_rejection "$EVIDENCE_DIR/stranger-announce.log" "0x118cdaa7" "announceMigration rejected the stranger for a reason other than ownership"
cast call --rpc-url "$ETH_RPC_URL" --from "$OWNER" "$FWSS_PROXY_ADDRESS" \
  'announceMigration(address,uint96)' "$PINNED_MIGRATION" 1 > "$EVIDENCE_DIR/owner-announce.log" 2>&1 \
  || { cat "$EVIDENCE_DIR/owner-announce.log" >&2; fail "the owner cannot announce a migration"; }
echo "TRANSITION_OK monolith=$MONOLITH dispatcher=$DISPATCHER transition=$TRANSITION migration=$PINNED_MIGRATION"
