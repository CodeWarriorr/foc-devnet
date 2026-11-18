import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getLogs, readContract, simulateContract } from 'viem/actions'
import {
  getAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
  type Address,
  type TransactionReceipt,
} from 'viem'
import type { ScenarioSynapse } from './account.ts'
import { send } from './fwss-chain.ts'
import { decodeRailState, railPreimage, type RailKey, type RailStateV2 } from './pay-rails.ts'

export { CDN_NONCE_FLAG, CREATE_RAIL, FLAG_CALLBACK, isV1RailId, type RailKey } from './pay-rails.ts'

export const payV2Abi = parseAbi([
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
  'function balanceOf(address owner, uint256 token) view returns (uint256)',
  'function authorize(address operator, uint256 permissions)',
  'function settleRail(address operator, address from, address recipient, uint64 nonce, uint256 token) returns (uint256 settledUpTo)',
  'function terminateRail(address operator, address from, address recipient, uint64 nonce, uint256 token)',
  'function extsload(bytes32 slot) view returns (bytes32)',
  'event RailCreated(address indexed payer, address indexed payee, address indexed operator, uint256 token, uint256 railId, uint64 nonce)',
  'event Transfer(address caller, address indexed sender, address indexed receiver, uint256 indexed id, uint256 amount)',
  'error Unauthorized(address user, address operator)',
  'error InsufficientBalance()',
  'error RailNotCreated()',
  'error Behind()',
  'error Exists()',
])

export const payV1ExtraAbi = parseAbi([
  'function operatorApprovals(address token, address client, address operator) view returns (bool isApproved, uint256 rateAllowance, uint256 lockupAllowance, uint256 rateUsage, uint256 lockupUsage, uint256 maxLockupPeriod)',
  'function getRailsForPayerAndToken(address payer, address token, uint256 offset, uint256 limit) view returns ((uint256 railId, bool isTerminated, uint256 endEpoch)[] results, uint256 nextOffset, uint256 total)',
  'function terminateRail(uint256 railId)',
  'function withdraw(address token, uint256 amount)',
  'event RailCreated(uint256 indexed railId, address indexed payer, address indexed payee, address token, address operator, address validator, address serviceFeeRecipient, uint256 commissionRateBps)',
])

/** RailIdLibrary.deriveRail's storage slot, which FilecoinPayV2 uses as the rail id. */
export function railIdV2(key: RailKey): bigint {
  return BigInt(keccak256(railPreimage(key)))
}

/** FilecoinPayV2's address: an explicit override, else the devnet-info.json export. */
export function payV2Address(): Address | undefined {
  const override = process.env.FILECOIN_PAY_V2_ADDRESS
  if (override) return getAddress(override)
  const path = process.env.DEVNET_INFO_PATH
  if (!path) return undefined
  const exported = JSON.parse(readFileSync(path, 'utf8')).info.contracts?.filecoin_pay_v2_addr
  return typeof exported === 'string' ? getAddress(exported) : undefined
}

export function tokenId(token: Address): bigint {
  return BigInt(token)
}

export async function railStateV2(synapse: ScenarioSynapse, pay: Address, railId: bigint): Promise<RailStateV2> {
  const word = await readContract(synapse.client, {
    address: pay,
    abi: payV2Abi,
    functionName: 'extsload',
    args: [toHex(railId, { size: 32 })],
  })
  return decodeRailState(word)
}

export async function balanceV2(synapse: ScenarioSynapse, pay: Address, owner: Address, token: Address) {
  return readContract(synapse.client, { address: pay, abi: payV2Abi, functionName: 'balanceOf', args: [owner, tokenId(token)] })
}

export function railCreatedV2(receipt: TransactionReceipt, pay: Address) {
  return parseEventLogs({ abi: payV2Abi, logs: receipt.logs, eventName: 'RailCreated', strict: true }).filter(
    (log) => log.address.toLowerCase() === pay.toLowerCase()
  )
}

/** Every RailCreated FilecoinPayV1 emitted from `fromBlock`, in Lotus-sized chunks. */
export async function v1RailsCreatedSince(synapse: ScenarioSynapse, payV1: Address, fromBlock: bigint, toBlock: bigint) {
  const created = []
  for (let start = fromBlock; start <= toBlock; start += 2_000n) {
    const end = start + 1_999n < toBlock ? start + 1_999n : toBlock
    created.push(
      ...(await getLogs(synapse.client, {
        address: payV1,
        event: payV1ExtraAbi[4],
        fromBlock: start,
        toBlock: end,
      }))
    )
  }
  return created
}

/** Deposits `amount` of `token` into FilecoinPayV2 and checks the balance it adds. */
export async function depositV2(synapse: ScenarioSynapse, pay: Address, token: Address, amount: bigint) {
  const owner = synapse.client.account.address
  const before = await balanceV2(synapse, pay, owner, token)
  const approval = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: token,
    abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
    functionName: 'approve',
    args: [pay, amount],
  })
  await send(synapse, approval.request, 'FilecoinPayV2 USDFC approval')
  const deposit = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: pay,
    abi: payV2Abi,
    functionName: 'deposit',
    args: [token, amount],
  })
  await send(synapse, deposit.request, 'FilecoinPayV2 deposit')
  const after = await balanceV2(synapse, pay, owner, token)
  assert.equal(after - before, amount, 'FilecoinPayV2 balance did not grow by the deposit')
  return after
}

export async function authorizeV2(synapse: ScenarioSynapse, pay: Address, operator: Address, permissions: bigint) {
  const { request } = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: pay,
    abi: payV2Abi,
    functionName: 'authorize',
    args: [operator, permissions],
  })
  return send(synapse, request, `FilecoinPayV2 authorize(${permissions})`)
}

export async function settleV2(synapse: ScenarioSynapse, pay: Address, key: RailKey) {
  const { request, result } = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: pay,
    abi: payV2Abi,
    functionName: 'settleRail',
    args: [key.operator, key.from, key.recipient, key.nonce, tokenId(key.token)],
  })
  const receipt = await send(synapse, request, 'FilecoinPayV2 settleRail')
  return { receipt, settledUpTo: result }
}
