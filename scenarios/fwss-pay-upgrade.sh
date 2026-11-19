#!/usr/bin/env bash
# Upgrades a devnet FWSS proxy that runs a dispatcher release (v1.6.0 or later)
# to a candidate that adds FilecoinPayV2, with Procedure B (josuke migration) of
# the candidate's tools/UPGRADE-CHECKLIST.md. Lines marked "DEVNET:" are the
# only departures, each with its reason.
#
# Required environment:
#   BASELINE_SERVICES_DIR   service_contracts/ checkout of the commit the devnet deployed
#   CANDIDATE_SERVICES_DIR  service_contracts/ checkout of the candidate
#   ETH_RPC_URL, CHAIN, FWSS_PROXY_ADDRESS
#   OWNER_PRIVATE_KEY       devnet key of the FWSS owner
#   EVIDENCE_DIR            where logs and ledgers are kept
# Optional:
#   FILECOIN_PAY_V2_ADDRESS an existing FilecoinPayV2; deployed from the candidate when unset
#   UPGRADE_DELAY_EPOCHS    (default 40)
#   PRE_EXECUTE_HOOK        command run right before B4, to leave changes pending across it
set -euo pipefail

: "${BASELINE_SERVICES_DIR:?}" "${CANDIDATE_SERVICES_DIR:?}" "${ETH_RPC_URL:?}" "${CHAIN:?}"
: "${FWSS_PROXY_ADDRESS:?}" "${OWNER_PRIVATE_KEY:?}" "${EVIDENCE_DIR:?}"
UPGRADE_DELAY_EPOCHS="${UPGRADE_DELAY_EPOCHS:-40}"
mkdir -p "$EVIDENCE_DIR"
EVIDENCE_DIR="$(cd "$EVIDENCE_DIR" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n=== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
# A rejection counts only with the expected reason; an RPC or build error fails too.
expect_rejection() { grep -qi -- "$2" "$1" || { cat "$1" >&2; fail "$3"; }; }
head_epoch() { cast block-number --rpc-url "$ETH_RPC_URL"; }
wait_for_epoch() { until [ "$(head_epoch)" -ge "$1" ]; do sleep 4; done; }

# DEVNET: Calibnet and Mainnet sign with the operator's keystore. Build one from
# the devnet owner key so josuke and forge take the checklist's flags.
cast wallet import --keystore-dir "$WORK/keystores" owner \
  --private-key "$OWNER_PRIVATE_KEY" --unsafe-password devnet >/dev/null
KEYSTORE="$WORK/keystores/owner"
printf 'devnet' > "$WORK/password"
PASSWORD_FILE="$WORK/password"
OWNER="$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")"
export CHAIN ETH_RPC_URL
# Both checkouts read josuke.json in their own directory.
unset JOSUKE_LEDGER

# DEVNET: the checklist installs josuke and evm into the operator's PATH. Each
# checkout gets the revisions its own Makefile pins, into this run only.
install_tools() {
  local dir="$1" bin="$2"
  mkdir -p "$bin"
  make -C "$dir" install-evm EVM_INSTALL_DIR="$bin" >/dev/null
  UV_TOOL_DIR="$bin/../uv-$(basename "$bin")" UV_TOOL_BIN_DIR="$bin" make -C "$dir" install-josuke >/dev/null
}

read_plan() {
  local word
  word=$(cast storage --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 19)
  PLANNED_TARGET=$(cast to-check-sum-address "0x${word:26:40}")
  PLANNED_AFTER_EPOCH=$(cast to-dec "0x${word:2:24}")
  echo "Pending target: $PLANNED_TARGET, afterEpoch: $PLANNED_AFTER_EPOCH"
}

owner_send() {
  cast send --rpc-url "$ETH_RPC_URL" --private-key "$OWNER_PRIVATE_KEY" --json "$@"
}

# Runs `josuke deploy` and returns the migration it proposed for the proxy.
josuke_deploy() {
  local label="$1"
  if ETH_KEYSTORE="$KEYSTORE" ETH_PASSWORD="$PASSWORD_FILE" josuke deploy 2>&1 | tee "$EVIDENCE_DIR/$label-josuke-deploy.log"; then
    :
  else
    fail "$label: josuke deploy failed"
  fi
  josuke verify 2>&1 | tee "$EVIDENCE_DIR/$label-josuke-verify.log"
  MIGRATION=$(source tools/josuke.sh; josuke_proposed_migration "$FWSS_PROXY_ADDRESS")
  [ -n "$MIGRATION" ] || fail "$label: josuke deploy proposed no migration"
  echo "$label migration: $MIGRATION"
}

pinned_dispatcher_codehash() {
  grep -o '0x[0-9a-f]\{64\}' <<< "$(grep 'FWSS_DISPATCHER_CODE_HASH =' "$1/src/FWSSDispatcherTransition.sol")"
}

step "Choose the Upgrade Path"
IMPL=$(cast implementation --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS")
IMPL_CODEHASH=$(cast keccak "$(cast code --rpc-url "$ETH_RPC_URL" "$IMPL")")
PINNED_DISPATCHER_CODEHASH=$(pinned_dispatcher_codehash "$CANDIDATE_SERVICES_DIR")
echo "Implementation $IMPL, code hash $IMPL_CODEHASH"
[ "$IMPL_CODEHASH" = "$PINNED_DISPATCHER_CODEHASH" ] || fail "the proxy does not run the dispatcher; this script covers Path B only"
echo "Path B: dispatcher installed"
BASELINE_VERSION=$(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'VERSION()(string)')
echo "Baseline VERSION(): $BASELINE_VERSION"

# DEVNET: Calibnet and Mainnet have a josuke.json entry whose `current` names the
# installed facets. warm-storage-deploy-all.sh deploys a devnet's facets without
# recording them, so record the devnet proxy with the baseline's own josuke:
# redeploy the baseline facets and route the proxy to them through Procedure B.
# The candidate then upgrades from a ledger shaped like the live networks' ones.
step "DEVNET: record the baseline deployment in its josuke.json"
cd "$BASELINE_SERVICES_DIR"
install_tools "$BASELINE_SERVICES_DIR" "$WORK/baseline-bin"
dependency() { cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" "$1()(address)"; }
PAY_V1="$(dependency paymentsContractAddress)"
jq --indent 4 \
  --arg proxy "$(cast to-check-sum-address "$FWSS_PROXY_ADDRESS")" --arg chain "$CHAIN" \
  --arg pay "$PAY_V1" --arg pdp "$(dependency pdpVerifierAddress)" \
  --arg usdfc "$(dependency usdfcTokenAddress)" --arg beneficiary "$(dependency filBeamBeneficiaryAddress)" \
  --arg registry "$(dependency serviceProviderRegistry)" --arg sessions "$(dependency sessionKeyRegistry)" '
  . + [{
    address: $proxy,
    facetSrc: (map(select(.deployments["314"] != null)) | first | .facetSrc),
    deployments: {($chain): {
      constructorArgs: {
        _paymentsContractAddress: $pay, _pdpVerifierAddress: $pdp, _usdfc: $usdfc,
        _filBeamBeneficiaryAddress: $beneficiary, _serviceProviderRegistry: $registry,
        _sessionKeyRegistry: $sessions
      }
    }}
  }]' josuke.json > "$WORK/josuke.json"
mv "$WORK/josuke.json" josuke.json
PATH="$WORK/baseline-bin:$PATH" make erc8167 >/dev/null
(
  export PATH="$WORK/baseline-bin:$PATH"
  josuke_deploy "baseline-record"
  owner_send "$FWSS_PROXY_ADDRESS" 'announceMigration(address,uint96)' "$MIGRATION" 1 > "$EVIDENCE_DIR/baseline-record-announce.json"
  read_plan
  wait_for_epoch "$PLANNED_AFTER_EPOCH"
  owner_send "$FWSS_PROXY_ADDRESS" 'migrate(address)' "$MIGRATION" > "$EVIDENCE_DIR/baseline-record-migrate.json"
  josuke accept 2>&1 | tee "$EVIDENCE_DIR/baseline-record-accept.log"
)
[ "$(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'VERSION()(string)')" = "$BASELINE_VERSION" ] \
  || fail "recording the baseline changed VERSION()"
cp josuke.json "$EVIDENCE_DIR/baseline-josuke.json"
DEVNET_ENTRY=$(jq --arg proxy "$FWSS_PROXY_ADDRESS" \
  '.[] | select((.address | ascii_downcase) == ($proxy | ascii_downcase))' josuke.json)

cd "$CANDIDATE_SERVICES_DIR"
install_tools "$CANDIDATE_SERVICES_DIR" "$WORK/candidate-bin"
export PATH="$WORK/candidate-bin:$PATH"

# DEVNET: Calibnet and Mainnet get FilecoinPayV2 from its own release before the
# FWSS upgrade; here the candidate's submodule deploys it, as warm-storage-deploy-all.sh does.
if [ -z "${FILECOIN_PAY_V2_ADDRESS:-}" ]; then
  step "DEVNET: deploy FilecoinPayV2 from the candidate"
  forge create lib/filecoin-pay-v2/src/FilecoinPayV2.sol:FilecoinPayV2 \
    --rpc-url "$ETH_RPC_URL" --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE" --broadcast --json \
    > "$EVIDENCE_DIR/filecoin-pay-v2-deploy.json"
  FILECOIN_PAY_V2_ADDRESS=$(jq -r '.deployedTo' "$EVIDENCE_DIR/filecoin-pay-v2-deploy.json")
fi
FILECOIN_PAY_V2_ADDRESS=$(cast to-check-sum-address "$FILECOIN_PAY_V2_ADDRESS")
[ "$(cast code --rpc-url "$ETH_RPC_URL" "$FILECOIN_PAY_V2_ADDRESS")" != "0x" ] || fail "FilecoinPayV2 has no code"
echo "FilecoinPayV2: $FILECOIN_PAY_V2_ADDRESS"

step "Record the devnet proxy in the candidate's josuke.json"
# The live entries say which constructor arguments the candidate's facets take.
for live in 314 314159; do
  if ! jq -e --arg chain "$live" 'any(.[]; .deployments[$chain].constructorArgs._filecoinPayV2Address != null)' josuke.json >/dev/null; then
    echo "CHECKLIST_DEVIATION=candidate josuke.json has no _filecoinPayV2Address for chain $live; josuke deploy cannot build the v2 facets there"
  fi
done
jq --indent 4 --argjson entry "$DEVNET_ENTRY" --arg chain "$CHAIN" --arg pay2 "$FILECOIN_PAY_V2_ADDRESS" \
  '(map(select(.deployments["314"] != null)) | first | .facetSrc) as $src
   | . + [$entry | .facetSrc = $src | .deployments[$chain].constructorArgs._filecoinPayV2Address = $pay2]' \
  josuke.json > "$WORK/josuke.json"
mv "$WORK/josuke.json" josuke.json
make erc8167 >/dev/null

step "B1: Deploy"
josuke_deploy "B1"
cp josuke.json "$EVIDENCE_DIR/B1-josuke.json"

step "B2: Announce"
CALLDATA=$(cast calldata 'announceMigration(address,uint96)' "$MIGRATION" "$UPGRADE_DELAY_EPOCHS")
cast 4byte-calldata "$CALLDATA" || true
# DEVNET: the owner is an EOA, not a Safe, so it sends the announcement itself.
BEFORE=$(head_epoch)
owner_send "$FWSS_PROXY_ADDRESS" "$CALLDATA" > "$EVIDENCE_DIR/B2-announce.json"
AFTER=$(head_epoch)
read_plan
[ "$PLANNED_TARGET" = "$(cast to-check-sum-address "$MIGRATION")" ] || fail "pending target is not the migration"
ANNOUNCED_AT=$((PLANNED_AFTER_EPOCH - UPGRADE_DELAY_EPOCHS))
[ "$ANNOUNCED_AT" -ge "$BEFORE" ] && [ "$ANNOUNCED_AT" -le "$AFTER" ] \
  || fail "afterEpoch $PLANNED_AFTER_EPOCH is not the announce block plus $UPGRADE_DELAY_EPOCHS"

step "Execute before afterEpoch must fail"
[ "$(head_epoch)" -lt "$PLANNED_AFTER_EPOCH" ] || fail "the delay passed before the early execute attempt; raise UPGRADE_DELAY_EPOCHS"
if cast call --rpc-url "$ETH_RPC_URL" --from "$OWNER" "$FWSS_PROXY_ADDRESS" 'migrate(address)' "$MIGRATION" \
  > "$EVIDENCE_DIR/early-migrate.log" 2>&1; then
  fail "the proxy accepted migrate before afterEpoch"
fi
expect_rejection "$EVIDENCE_DIR/early-migrate.log" "$(cast sig 'MigrationNotReady(uint96)')" \
  "migrate failed for a reason other than MigrationNotReady"
echo "Early migrate rejected"

step "B3: Review During the Delay"
read_plan
[ "$PLANNED_TARGET" = "$(cast to-check-sum-address "$MIGRATION")" ] || fail "pending target changed"
josuke verify
IMPL_CODEHASH=$(cast keccak "$(cast code --rpc-url "$ETH_RPC_URL" "$(cast implementation --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS")")")
[ "$IMPL_CODEHASH" = "$PINNED_DISPATCHER_CODEHASH" ] || fail "the proxy no longer runs the dispatcher"

step "Wait for afterEpoch $PLANNED_AFTER_EPOCH"
wait_for_epoch "$PLANNED_AFTER_EPOCH"

if [ -n "${PRE_EXECUTE_HOOK:-}" ]; then
  step "Pre-execute hook"
  bash -c "$PRE_EXECUTE_HOOK"
fi

step "B4: Execute"
read_plan
[ "$PLANNED_TARGET" = "$(cast to-check-sum-address "$MIGRATION")" ] || fail "STOP: the pending plan is not the reviewed migration"
josuke verify || fail "STOP: josuke verify failed"
CALLDATA=$(cast calldata 'migrate(address)' "$MIGRATION")
cast call --rpc-url "$ETH_RPC_URL" --from "$OWNER" "$FWSS_PROXY_ADDRESS" "$CALLDATA" > /dev/null \
  || fail "migrate simulation reverted"
echo "Simulation succeeded"
# DEVNET: no Safe; the owner sends the same calldata.
owner_send "$FWSS_PROXY_ADDRESS" "$CALLDATA" > "$EVIDENCE_DIR/B4-migrate.json"
[ "$(jq -r .status "$EVIDENCE_DIR/B4-migrate.json")" = "0x1" ] || fail "migrate reverted"
UPGRADE_BLOCK=$(cast to-dec "$(jq -r .blockNumber "$EVIDENCE_DIR/B4-migrate.json")")
echo "UPGRADE_BLOCK=$UPGRADE_BLOCK"

step "Post-Upgrade Checks"
IMPL_CODEHASH=$(cast keccak "$(cast code --rpc-url "$ETH_RPC_URL" "$(cast implementation --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS")")")
[ "$IMPL_CODEHASH" = "$PINNED_DISPATCHER_CODEHASH" ] || fail "the proxy does not run the pinned dispatcher"
read_plan
[ "$PLANNED_AFTER_EPOCH" = "0" ] && [ "$PLANNED_TARGET" = "0x0000000000000000000000000000000000000000" ] || fail "slot 19 is not cleared"
[ "$(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'owner()(address)')" = "$OWNER" ] || fail "owner changed"
echo "VERSION(): $(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'VERSION()(string)') (was $BASELINE_VERSION)"
for sig in 'announceMigration(address,uint96)' 'migrate(address)' 'implementation(bytes4)' 'selectors()'; do
  route=$(cast call --rpc-url "$ETH_RPC_URL" "$FWSS_PROXY_ADDRESS" 'implementation(bytes4)(address)' "$(cast sig "$sig")")
  echo "$sig -> $route"
  [ "$route" != "0x0000000000000000000000000000000000000000" ] || fail "$sig has no route"
done
# Existing data sets keep their FilecoinPayV1 rails, so v1 stays the payments contract FWSS reports.
[ "$(dependency paymentsContractAddress)" = "$PAY_V1" ] || fail "paymentsContractAddress changed"
josuke accept 2>&1 | tee "$EVIDENCE_DIR/josuke-accept.log"
cp josuke.json "$EVIDENCE_DIR/final-josuke.json"
echo "FILECOIN_PAY_V2_ADDRESS=$FILECOIN_PAY_V2_ADDRESS"
echo "PAY_V2_UPGRADE_OK migration=$MIGRATION"
