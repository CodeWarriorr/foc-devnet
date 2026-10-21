// Prepares state on the v1.4.0 FWSS monolith, then checks it after the one-time
// ERC-8167 dispatcher transition. Remove with test_fwss_transition.py once
// Calibnet and Mainnet run the dispatcher.
//
//   node fwss-transition.ts prepare  <checkpoint.json> <file>
//   node fwss-transition.ts arm      <checkpoint.json> <file>   (right before execute)
//   node fwss-transition.ts continue <checkpoint.json> <file>
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as ERC20 from '@filoz/synapse-core/erc20'
import { deposit, getRail } from '@filoz/synapse-core/pay'
import { getActivePieceCount } from '@filoz/synapse-core/pdp-verifier'
import * as Piece from '@filoz/synapse-core/piece'
import { AddPiecesPermission, fromSecp256k1, login } from '@filoz/synapse-core/session-key'
import { getPdpDataSet } from '@filoz/synapse-core/warm-storage'
import { Synapse } from '@filoz/synapse-sdk'
import {
  call,
  getBlockNumber,
  getChainId,
  getLogs,
  getTransactionReceipt,
  readContract,
  simulateContract,
} from 'viem/actions'
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  parseUnits,
  toHex,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSynapse, prepareAccount, readAccountState, type ScenarioSynapse } from './account.ts'
import { freshMetadata, resolveEnvironment, type ScenarioEnvironment } from './environment.ts'
import {
  contractsOf,
  delay,
  expectedStorageRate,
  pdpAbi,
  send,
  settleExactly,
  waitForNextChallenge,
  waitForPeriodEnd,
  waitForReceipt,
  type ProvingPeriod,
} from './fwss-chain.ts'
import { assertReceiptSucceeded, calculateSettlementAmounts, findRevertErrorName } from './lifecycle-assertions.ts'
import { createFreshContext } from './storage.ts'

const fwssAbi = parseAbi([
  'function viewContractAddress() view returns (address)',
  'function settleFilBeamPaymentRails(uint256 dataSetId, uint256 cdnAmount, uint256 cacheMissAmount)',
])

const railAbi = parseAbi([
  'function getRail(uint256 railId) view returns ((address token, address from, address to, address operator, address validator, uint256 paymentRate, uint256 lockupPeriod, uint256 lockupFixed, uint256 settledUpTo, uint256 endEpoch, uint256 commissionRateBps, address serviceFeeRecipient))',
  'function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)',
])

const nextProvingPeriodEvent = parseAbiItem(
  'event NextProvingPeriod(uint256 indexed setId, uint256 challengeEpoch, uint256 leafCount)'
)
const possessionProvenEvent = parseAbiItem(
  'event PossessionProven(uint256 indexed setId, (uint256 pieceId, uint256 offset)[] challenges)'
)

type ProvenPeriod = ProvingPeriod & {
  period: bigint
  /** Proven periods from the first one searched up to and including `period`. */
  provenCount: bigint
  /** Block of the PossessionProven event that proved `period`. */
  proofBlock: bigint
}

/**
 * Waits for the first proven period at or after `atLeast`, searching at most `limit` periods.
 * A loaded devnet Curio can miss a challenge window, so callers pay for the periods that were
 * proven instead of assuming all were. FWSS's record of each period from `from` on must match
 * PDPVerifier's PossessionProven events.
 */
async function waitForProvenPeriod(
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  from: bigint,
  atLeast: bigint = from,
  limit = 4n
): Promise<ProvenPeriod> {
  const client = createPublicClient({ chain: environment.chain, transport: http(), ccipRead: false })
  let provenCount = 0n
  for (let period = from; period < atLeast + limit; period++) {
    const result = await waitForPeriodEnd(environment, dataSetId, period)
    const logs = await getLogs(client, {
      address: contractsOf(environment).pdpVerifier,
      event: possessionProvenEvent,
      args: { setId: dataSetId },
      fromBlock: result.deadline - result.maxProvingPeriod + 1n,
      toBlock: result.deadline,
    })
    assert.equal(result.proven, logs.length > 0, `FWSS and PDPVerifier disagree on period ${period} of data set ${dataSetId}`)
    if (!result.proven) continue
    provenCount++
    if (period >= atLeast) return { ...result, period, provenCount, proofBlock: logs[0].blockNumber }
  }
  throw new Error(`Data set ${dataSetId} proved no period from ${atLeast} to ${atLeast + limit - 1n}`)
}
const piecesRemovedEvent = parseAbiItem('event PiecesRemoved(uint256 indexed setId, uint256[] pieceIds)')

type DataSetRecord = { dataSetId: bigint; providerId: bigint; pdpRailId: bigint }

type Checkpoint = {
  runId: string
  proxy: Address
  stateView: Address
  client: Address
  steady: DataSetRecord & {
    rate: bigint
    activationEpoch: bigint
    maxProvingPeriod: bigint
    settledUpTo: bigint
    settledPeriod: bigint
  }
  changing: DataSetRecord & { pieceIds: bigint[] }
  cdn: DataSetRecord & { cdnRailId: bigint; cacheMissRailId: bigint }
  sessionKey: { privateKey: Hex; address: Address }
  presigned: { pieceCid: string; extraData: Hex }
  armed?: { removedPieceId: bigint; armedAtBlock: bigint }
}

// JSON cannot hold bigint; mark them with an `n` suffix.
function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  writeFileSync(path, JSON.stringify(checkpoint, (_, v) => (typeof v === 'bigint' ? `${v}n` : v), 2))
}

function loadCheckpoint(path: string): Checkpoint {
  return JSON.parse(readFileSync(path, 'utf8'), (_, v) =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
  )
}

function devnetInfo(): {
  foc_deployer: { evm_addr: string; private_key_hex: string }
  contracts: { fwss_service_proxy_addr: string }
} {
  const path = process.env.DEVNET_INFO_PATH
  assert(path, 'DEVNET_INFO_PATH is required')
  return JSON.parse(readFileSync(path, 'utf8')).info
}

function stateViewAbi(): Abi {
  const path = process.env.FWSS_STATE_VIEW_ABI
  assert(path, 'FWSS_STATE_VIEW_ABI must name the v1.4.0 FilecoinWarmStorageServiceStateView ABI')
  return JSON.parse(readFileSync(path, 'utf8'))
}

function requiredBigInt(name: string): bigint {
  const value = process.env[name]
  assert(value != null && /^\d+$/.test(value), `${name} must be a block number`)
  return BigInt(value)
}

async function activePieces(synapse: ScenarioSynapse, environment: ScenarioEnvironment, dataSetId: bigint) {
  return getActivePieceCount(synapse.client, { dataSetId, contractAddress: contractsOf(environment).pdpVerifier })
}

async function dataSetRecord(synapse: ScenarioSynapse, environment: ScenarioEnvironment, dataSetId: bigint) {
  const dataSet = await getPdpDataSet(synapse.client, {
    dataSetId,
    contractAddress: contractsOf(environment).fwssStateView,
  })
  assert(dataSet != null, `Data set ${dataSetId} is not readable`)
  return dataSet
}

async function createDataSet(
  synapse: ScenarioSynapse,
  providerId: bigint,
  pieces: Uint8Array[],
  kind: string,
  withCDN: boolean
) {
  const context = withCDN
    ? await synapse.storage.createContext({ providerId, metadata: freshMetadata(kind), withCDN: true })
    : await createFreshContext(synapse, providerId, freshMetadata(kind))
  const preparation = await synapse.storage.prepare({ context, pieceSizes: pieces.map((p) => BigInt(p.byteLength)) })
  if (preparation.transaction != null) {
    await preparation.transaction.execute({ onHash: (hash) => console.log(`${kind} funding submitted: ${hash}`) })
  }
  const stored = []
  for (const bytes of pieces) stored.push(await context.store(bytes))
  const committed = await context.commit({
    pieces: stored.map((s) => ({ pieceCid: s.pieceCid })),
    onSubmitted: (hash) => console.log(`${kind} commit submitted: ${hash}`),
  })
  assert.equal(committed.isNewDataSet, true, `${kind} did not create a new data set`)
  assert.equal(committed.pieceIds.length, pieces.length, `${kind} did not confirm every piece`)
  console.log(`${kind}: data set ${committed.dataSetId} on provider ${providerId}, pieces ${committed.pieceIds}`)
  return { context, committed, stored }
}

function variant(bytes: Uint8Array, tag: number): Uint8Array {
  const copy = Uint8Array.from(bytes)
  copy[0] ^= tag
  return copy
}

// ── FilBeam CDN rails ────────────────────────────────────────

async function settleCdnExactly(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  checkpoint: Checkpoint,
  cdnAmount: bigint,
  cacheMissAmount: bigint,
  label: string
): Promise<void> {
  const contracts = contractsOf(environment)
  const controller = privateKeyToAccount(devnetInfo().foc_deployer.private_key_hex as Hex)
  const wallet = createWalletClient({ account: controller, chain: environment.chain, transport: http() })
  const rails = await Promise.all(
    [checkpoint.cdn.cdnRailId, checkpoint.cdn.cacheMissRailId].map((railId) =>
      readContract(synapse.client, { address: contracts.filecoinPay, abi: railAbi, functionName: 'getRail', args: [railId] })
    )
  )
  const balance = (owner: Address) =>
    readContract(synapse.client, {
      address: contracts.filecoinPay,
      abi: railAbi,
      functionName: 'accounts',
      args: [rails[0].token, owner],
    }).then(([funds]) => funds)
  const [payerBefore, cdnPayeeBefore, cacheMissPayeeBefore] = await Promise.all([
    readAccountState(synapse),
    balance(rails[0].to),
    balance(rails[1].to),
  ])
  const { request } = await simulateContract(wallet, {
    address: checkpoint.proxy,
    abi: fwssAbi,
    functionName: 'settleFilBeamPaymentRails',
    args: [checkpoint.cdn.dataSetId, cdnAmount, cacheMissAmount],
  })
  const hash = await wallet.writeContract(request)
  const receipt = await waitForReceipt(synapse, hash, label)
  assert.equal(receipt.status, 'success', `${label} reverted`)
  const railsAfter = await Promise.all(
    [checkpoint.cdn.cdnRailId, checkpoint.cdn.cacheMissRailId].map((railId) =>
      readContract(synapse.client, { address: contracts.filecoinPay, abi: railAbi, functionName: 'getRail', args: [railId] })
    )
  )
  const [payerAfter, cdnPayeeAfter, cacheMissPayeeAfter] = await Promise.all([
    readAccountState(synapse),
    balance(rails[0].to),
    balance(rails[1].to),
  ])
  assert.equal(payerBefore.funds - payerAfter.funds, cdnAmount + cacheMissAmount, `${label}: payer debit differs`)
  assert.equal(rails[0].lockupFixed - railsAfter[0].lockupFixed, cdnAmount, `${label}: CDN lockup not reduced by its payment`)
  assert.equal(rails[1].lockupFixed - railsAfter[1].lockupFixed, cacheMissAmount, `${label}: cache-miss lockup not reduced by its payment`)
  const cdnNet = calculateSettlementAmounts(cdnAmount, rails[0].commissionRateBps).netPayee
  const cacheMissNet = calculateSettlementAmounts(cacheMissAmount, rails[1].commissionRateBps).netPayee
  if (rails[0].to === rails[1].to) {
    assert.equal(cdnPayeeAfter - cdnPayeeBefore, cdnNet + cacheMissNet, `${label}: CDN payee credit differs`)
  } else {
    assert.equal(cdnPayeeAfter - cdnPayeeBefore, cdnNet, `${label}: CDN payee credit differs`)
    assert.equal(cacheMissPayeeAfter - cacheMissPayeeBefore, cacheMissNet, `${label}: cache-miss payee credit differs`)
  }
  console.log(`${label}: dataSet=${checkpoint.cdn.dataSetId} cdn=${cdnAmount} cacheMiss=${cacheMissAmount} tx=${hash}`)
}

// ── Read parity ──────────────────────────────────────────────

/** Every v1.4.0 StateView getter, with arguments drawn from the prepared state. */
function viewCalls(checkpoint: Checkpoint, presignedNonce: bigint): [string, readonly unknown[]][] {
  const sets = [checkpoint.steady, checkpoint.changing, checkpoint.cdn]
  const ids = sets.map((s) => s.dataSetId)
  const providers = [...new Set(sets.map((s) => s.providerId))]
  const rails = [checkpoint.steady.pdpRailId, checkpoint.cdn.cdnRailId, checkpoint.cdn.cacheMissRailId]
  const calls: [string, readonly unknown[]][] = [
    ['clientDataSets', [checkpoint.client, 0n, 10n]],
    ['clientDataSets', [checkpoint.client]],
    ['clientNonces', [checkpoint.client, presignedNonce]],
    ['filBeamControllerAddress', []],
    ['getApprovedProviders', [0n, 10n]],
    ['getApprovedProvidersLength', []],
    ['getClientDataSets', [checkpoint.client, 0n, 10n]],
    ['getClientDataSets', [checkpoint.client]],
    ['getClientDataSetsLength', [checkpoint.client]],
    ['getCurrentPricingRates', []],
    ['getDataSetMetadata', [checkpoint.cdn.dataSetId, 'withCDN']],
    ['getDataSetSizeInBytes', [64n]],
    ['getPDPConfig', []],
    ['getPriceList', []],
    ['nextUpgrade', []],
    // service() is the StateView's own immutable, not an FWSS getter.
    ['serviceCommissionBps', []],
  ]
  for (const id of ids) {
    for (const fn of [
      'getAllDataSetMetadata',
      'getDataSet',
      'getDataSetAuthorizer',
      'getDataSetStatus',
      'nextPDPChallengeWindowStart',
      'provenThisPeriod',
      'provingActivationEpoch',
      'provingDeadline',
    ]) {
      calls.push([fn, [id]])
    }
    calls.push(['provenPeriods', [id, 0n]], ['provenPeriods', [id, 1n]])
  }
  for (const provider of providers) calls.push(['isProviderApproved', [provider]])
  for (const rail of rails) calls.push(['railToDataSet', [rail]])
  return calls
}

// Getters that proving and the passage of epochs leave unchanged.
const STATIC_VIEWS = new Set([
  'filBeamControllerAddress',
  'getAllDataSetMetadata',
  'getApprovedProviders',
  'getApprovedProvidersLength',
  'getCurrentPricingRates',
  'getDataSet',
  'getDataSetAuthorizer',
  'getDataSetMetadata',
  'getDataSetSizeInBytes',
  'getPriceList',
  'isProviderApproved',
  'provingActivationEpoch',
  'railToDataSet',
  'serviceCommissionBps',
])

async function rawCall(synapse: ScenarioSynapse, to: Address, data: Hex, blockNumber: bigint): Promise<string> {
  try {
    const result = await call(synapse.client, { to, data, blockNumber })
    return `ok:${result.data ?? '0x'}`
  } catch (error) {
    let current: unknown = error
    while (current != null && typeof current === 'object') {
      const data = (current as { data?: unknown }).data
      if (typeof data === 'string' && data.startsWith('0x')) return `revert:${data}`
      current = (current as { cause?: unknown }).cause
    }
    // No revert data: an RPC failure, which must not count as agreement.
    throw error
  }
}

async function readViews(
  synapse: ScenarioSynapse,
  target: Address,
  calls: [string, readonly unknown[]][],
  blockNumber: bigint
): Promise<Record<string, string>> {
  const abi = stateViewAbi()
  const results: Record<string, string> = {}
  for (const [functionName, args] of calls) {
    const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0])
    results[`${functionName}(${args.map(String).join(',')})`] = await rawCall(synapse, target, data, blockNumber)
  }
  return results
}

// ── Gas of Curio's proving transactions ──────────────────────

async function provingGas(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  fromBlock: bigint,
  transitionBlock: bigint
) {
  const address = contractsOf(environment).pdpVerifier
  const head = await getBlockNumber(synapse.client)
  const report: Record<string, { before: bigint[]; after: bigint[] }> = {}
  for (const event of [nextProvingPeriodEvent, possessionProvenEvent]) {
    const logs = []
    // Lotus serves at most 2880 blocks of logs per request.
    for (let start = fromBlock; start <= head; start += 2_000n) {
      const toBlock = start + 1_999n < head ? start + 1_999n : head
      logs.push(...(await getLogs(synapse.client, { address, event, args: { setId: dataSetId }, fromBlock: start, toBlock })))
    }
    const entry = { before: [] as bigint[], after: [] as bigint[] }
    for (const log of logs) {
      const receipt = await getTransactionReceipt(synapse.client, { hash: log.transactionHash })
      ;(log.blockNumber < transitionBlock ? entry.before : entry.after).push(receipt.gasUsed)
    }
    report[event.name] = entry
  }
  return report
}

// ── Phases ───────────────────────────────────────────────────

// Synapse deposits the exact shortfall, but rails from earlier scenarios keep consuming lockup until
// the commit lands, which can leave the CDN lockup a few wei short.
const FUNDING_HEADROOM = parseUnits('5', 18)

async function depositHeadroom(synapse: ScenarioSynapse): Promise<void> {
  const approval = await ERC20.approve(synapse.client, { amount: FUNDING_HEADROOM })
  assertReceiptSucceeded(await waitForReceipt(synapse, approval, 'Headroom USDFC approval'), 'Headroom USDFC approval')
  const hash = await deposit(synapse.client, { amount: FUNDING_HEADROOM })
  assertReceiptSucceeded(await waitForReceipt(synapse, hash, 'Headroom deposit'), 'Headroom deposit')
}

async function prepare(environment: ScenarioEnvironment, checkpointPath: string, filePath: string): Promise<void> {
  const contracts = contractsOf(environment)
  const synapse = createSynapse(environment)
  const info = devnetInfo()
  const proxy = info.contracts.fwss_service_proxy_addr as Address
  const providerIds = [1n, 2n]
  const source = new Uint8Array(await readFile(filePath))
  await prepareAccount(synapse, BigInt(source.byteLength) * 8n)
  await depositHeadroom(synapse)

  // A: one piece and a constant rate, for exact settlement and gas across the transition.
  const steady = await createDataSet(synapse, providerIds[0], [variant(source, 0x01)], 'transition-steady', false)
  // B: receives the late changes: a scheduled removal, an unproven piece, a presigned add, and a session-key add.
  const changing = await createDataSet(
    synapse,
    providerIds[1],
    [variant(source, 0x02), variant(source, 0x03)],
    'transition-changing',
    false
  )
  // C: FilBeam CDN rails.
  const cdn = await createDataSet(synapse, providerIds[0], [variant(source, 0x04)], 'transition-cdn', true)

  const [steadyInfo, changingInfo, cdnInfo] = await Promise.all(
    [steady, changing, cdn].map((d) => dataSetRecord(synapse, environment, d.committed.dataSetId))
  )
  assert(cdnInfo.cdnRailId > 0n && cdnInfo.cacheMissRailId > 0n, 'CDN data set has no FilBeam rails')

  // A session key that v1.4.0 registers and the dispatcher must still honor.
  const sessionPrivateKey = generatePrivateKey()
  const sessionAddress = privateKeyToAccount(sessionPrivateKey).address
  // loginSync waits through viem, which reads whole blocks and fails on Lotus null rounds.
  const loginHash = await login(synapse.client, {
    address: sessionAddress,
    permissions: [AddPiecesPermission],
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400),
  })
  assertReceiptSucceeded(await waitForReceipt(synapse, loginHash, 'Session key login'), 'Session key login')
  console.log(`Session key ${sessionAddress} registered: ${loginHash}`)

  // A signature made under v1.4.0, submitted only after the transition.
  const presignedBytes = variant(source, 0x05)
  const presignedStored = await changing.context.store(presignedBytes)
  const presignedExtraData = await changing.context.presignForCommit([{ pieceCid: presignedStored.pieceCid }])

  const first = await waitForProvenPeriod(environment, steady.committed.dataSetId, 0n)
  for (const id of [changing.committed.dataSetId, cdn.committed.dataSetId]) {
    await waitForProvenPeriod(environment, id, 0n)
  }

  const { expectedRate } = await expectedStorageRate(synapse, environment, steady.committed.dataSetId)
  const steadyRail = await getRail(synapse.client, { railId: steadyInfo.pdpRailId })
  assert.equal(steadyRail.paymentRate, expectedRate, 'Steady rail rate differs from size and price list')
  await settleExactly(
    synapse,
    environment,
    steadyInfo.pdpRailId,
    first.deadline,
    expectedRate * first.maxProvingPeriod * first.provenCount,
    'Steady rail settlement before the transition'
  )

  const checkpoint: Checkpoint = {
    runId: environment.runId ?? '',
    proxy,
    stateView: contracts.fwssStateView,
    client: synapse.client.account.address,
    steady: {
      dataSetId: steady.committed.dataSetId,
      providerId: providerIds[0],
      pdpRailId: steadyInfo.pdpRailId,
      rate: expectedRate,
      activationEpoch: first.activationEpoch,
      maxProvingPeriod: first.maxProvingPeriod,
      settledUpTo: first.deadline,
      settledPeriod: first.period,
    },
    changing: {
      dataSetId: changing.committed.dataSetId,
      providerId: providerIds[1],
      pdpRailId: changingInfo.pdpRailId,
      pieceIds: changing.committed.pieceIds,
    },
    cdn: {
      dataSetId: cdn.committed.dataSetId,
      providerId: providerIds[0],
      pdpRailId: cdnInfo.pdpRailId,
      cdnRailId: cdnInfo.cdnRailId,
      cacheMissRailId: cdnInfo.cacheMissRailId,
    },
    sessionKey: { privateKey: sessionPrivateKey, address: sessionAddress },
    presigned: { pieceCid: presignedStored.pieceCid.toString(), extraData: presignedExtraData },
  }
  await settleCdnExactly(synapse, environment, checkpoint, 1_000n, 2_000n, 'FilBeam settlement before the transition')

  saveCheckpoint(checkpointPath, checkpoint)
  console.log(`=== PREPARED: v1.4.0 state recorded in ${checkpointPath} ===`)
}

/** Runs right before the execute transaction, so both changes are still pending across it. */
async function arm(environment: ScenarioEnvironment, checkpointPath: string, filePath: string): Promise<void> {
  const synapse = createSynapse(environment)
  const checkpoint = loadCheckpoint(checkpointPath)
  const id = checkpoint.changing.dataSetId
  // Start at a period boundary so the provider applies neither change before the transition.
  const head = await getBlockNumber(synapse.client)
  const period = (head - (await readContract(synapse.client, {
    address: checkpoint.stateView,
    abi: parseAbi(['function provingActivationEpoch(uint256) view returns (uint256)']),
    functionName: 'provingActivationEpoch',
    args: [id],
  }))) / checkpoint.steady.maxProvingPeriod
  await waitForPeriodEnd(environment, id, period)

  const context = await synapse.storage.createContext({ dataSetId: id })
  const source = new Uint8Array(await readFile(filePath))
  const unproven = await context.store(variant(source, 0x06))
  const committed = await context.commit({
    pieces: [{ pieceCid: unproven.pieceCid }],
    onSubmitted: (hash) => console.log(`Unproven piece commit submitted: ${hash}`),
  })
  const removedPieceId = checkpoint.changing.pieceIds[1]
  const removal = await context.deletePiece({ piece: removedPieceId })
  assertReceiptSucceeded(await waitForReceipt(synapse, removal, 'Piece removal scheduling'), 'Piece removal scheduling')
  const scheduled = await context.getScheduledRemovals()
  assert.deepEqual([...scheduled], [removedPieceId], 'Piece removal was not scheduled')
  checkpoint.armed = {
    removedPieceId,
    armedAtBlock: await getBlockNumber(synapse.client),
  }
  saveCheckpoint(checkpointPath, checkpoint)
  console.log(`=== ARMED: piece ${committed.pieceIds[0]} unproven, piece ${removedPieceId} scheduled for removal ===`)
}

async function proceed(environment: ScenarioEnvironment, checkpointPath: string, filePath: string): Promise<void> {
  const contracts = contractsOf(environment)
  const synapse = createSynapse(environment)
  const checkpoint = loadCheckpoint(checkpointPath)
  assert(checkpoint.armed != null, 'The arm phase did not run before the transition')
  const transitionBlock = requiredBigInt('FWSS_TRANSITION_BLOCK')
  const source = new Uint8Array(await readFile(filePath))

  // Integrators may still read through the v1.4.0 StateView; it reaches the proxy through extsload.
  const viewAddress = await readContract(synapse.client, {
    address: checkpoint.proxy,
    abi: fwssAbi,
    functionName: 'viewContractAddress',
  })
  assert.equal(viewAddress.toLowerCase(), checkpoint.proxy.toLowerCase(), 'viewContractAddress() does not return the proxy')

  const block = await getBlockNumber(synapse.client)
  const presignedNonce = 0n
  const calls = viewCalls(checkpoint, presignedNonce)
  const [throughProxy, throughStateView] = await Promise.all([
    readViews(synapse, checkpoint.proxy, calls, block),
    readViews(synapse, checkpoint.stateView, calls, block),
  ])
  const mismatches = Object.keys(throughProxy).filter((k) => throughProxy[k] !== throughStateView[k])
  assert.deepEqual(mismatches, [], `Proxy and v1.4.0 StateView disagree at block ${block}`)
  const reverted = Object.keys(throughProxy).filter((k) => throughProxy[k].startsWith('revert:'))
  assert.deepEqual(reverted, [], 'Getters revert through both the proxy and the v1.4.0 StateView')
  console.log(`Read parity: ${calls.length} getters agree through the proxy and the v1.4.0 StateView`)
  // Only the transition and Curio's proving share its block, so FWSS state must read the same on
  // both sides of it.
  const staticCalls = calls.filter(([fn]) => STATIC_VIEWS.has(fn))
  const [beforeTransition, afterTransition] = await Promise.all([
    readViews(synapse, checkpoint.stateView, staticCalls, transitionBlock - 1n),
    readViews(synapse, checkpoint.proxy, staticCalls, transitionBlock),
  ])
  const changed = Object.keys(beforeTransition).filter((k) => beforeTransition[k] !== afterTransition[k])
  assert.deepEqual(changed, [], 'FWSS state changed in the transition block')

  // Old data is still served.
  for (const id of [checkpoint.steady.dataSetId, checkpoint.cdn.dataSetId]) {
    const context = await synapse.storage.createContext({ dataSetId: id })
    for await (const piece of context.getPieces()) {
      const bytes = await context.download({ pieceCid: piece.pieceCid })
      assert(bytes.byteLength > 0, `Piece ${piece.pieceId} of data set ${id} is empty`)
    }
  }

  // The steady data set keeps proving, and payment across the transition is exact.
  const steady = checkpoint.steady
  // Period k spans (activation + kP, activation + (k+1)P]; this one holds the transition.
  const transitionPeriod = (transitionBlock - steady.activationEpoch) / steady.maxProvingPeriod
  let after = await waitForProvenPeriod(environment, steady.dataSetId, steady.settledPeriod + 1n, transitionPeriod)
  let provenCount = after.provenCount
  if (after.proofBlock <= transitionBlock) {
    // The transition period was proven under v1.4.0; the dispatcher must prove a later one.
    after = await waitForProvenPeriod(environment, steady.dataSetId, after.period + 1n)
    provenCount += after.provenCount
  }
  const { expectedRate } = await expectedStorageRate(synapse, environment, steady.dataSetId)
  assert.equal(expectedRate, steady.rate, 'Steady data set rate changed across the transition')
  await settleExactly(
    synapse,
    environment,
    steady.pdpRailId,
    after.deadline,
    steady.rate * steady.maxProvingPeriod * provenCount,
    'Steady rail settlement across the transition'
  )

  // The changes armed under v1.4.0 take effect under the dispatcher.
  const changing = checkpoint.changing
  const removedLogs = await getLogs(synapse.client, {
    address: contracts.pdpVerifier,
    event: piecesRemovedEvent,
    args: { setId: changing.dataSetId },
    fromBlock: checkpoint.armed.armedAtBlock,
  })
  for (let tries = 0; removedLogs.length === 0 && tries < 240; tries++) {
    await delay(5_000)
    removedLogs.push(
      ...(await getLogs(synapse.client, {
        address: contracts.pdpVerifier,
        event: piecesRemovedEvent,
        args: { setId: changing.dataSetId },
        fromBlock: checkpoint.armed.armedAtBlock,
      }))
    )
  }
  assert.equal(removedLogs.length, 1, 'The piece scheduled under v1.4.0 was not removed')
  assert(removedLogs[0].blockNumber > transitionBlock, 'The scheduled removal took effect before the transition; nothing was pending')
  assert.deepEqual(removedLogs[0].args.pieceIds, [checkpoint.armed.removedPieceId], 'A different piece was removed')
  await waitForNextChallenge(synapse, environment, changing.dataSetId)
  const changingRail = await getRail(synapse.client, { railId: changing.pdpRailId })
  assert.equal(
    changingRail.paymentRate,
    (await expectedStorageRate(synapse, environment, changing.dataSetId)).expectedRate,
    'Changing data set rate differs from its size after the removal'
  )
  const removalPeriod =
    (removedLogs[0].blockNumber -
      (await readContract(synapse.client, {
        address: checkpoint.proxy,
        abi: parseAbi(['function provingActivationEpoch(uint256) view returns (uint256)']),
        functionName: 'provingActivationEpoch',
        args: [changing.dataSetId],
      }))) /
    steady.maxProvingPeriod
  const changingPeriod = await waitForProvenPeriod(environment, changing.dataSetId, removalPeriod)
  assert(
    changingPeriod.proofBlock > removedLogs[0].blockNumber,
    'The changing data set, with its piece added under v1.4.0, was not proven after the transition'
  )

  // A signature made under v1.4.0 is accepted once, and its replay is rejected.
  const changingContext = await synapse.storage.createContext({ dataSetId: changing.dataSetId })
  const presignedPiece = Piece.from(checkpoint.presigned.pieceCid)
  const presignedCommit = await changingContext.commit({
    pieces: [{ pieceCid: presignedPiece }],
    extraData: checkpoint.presigned.extraData,
    onSubmitted: (hash) => console.log(`Presigned commit submitted: ${hash}`),
  })
  assert.equal(presignedCommit.pieceIds.length, 1, 'The presigned v1.4.0 signature was not accepted')
  const changingInfo = await dataSetRecord(synapse, environment, changing.dataSetId)
  const countBefore = await activePieces(synapse, environment, changing.dataSetId)
  try {
    await simulateContract(synapse.client, {
      account: changingInfo.serviceProvider,
      address: contracts.pdpVerifier,
      abi: pdpAbi,
      functionName: 'addPieces',
      args: [changing.dataSetId, zeroAddress, [{ data: toHex(presignedPiece.bytes) }], checkpoint.presigned.extraData],
    })
    throw new Error('Replay of the presigned v1.4.0 signature was accepted')
  } catch (error) {
    assert.equal(findRevertErrorName(error), 'ClientDataSetAlreadyRegistered', 'Replay was rejected for an unexpected reason')
  }
  assert.equal(await activePieces(synapse, environment, changing.dataSetId), countBefore, 'Rejected replay changed the data set')
  console.log('Presigned v1.4.0 signature accepted once; replay rejected')

  // The session key registered under v1.4.0 still authorizes adds.
  const sessionKey = fromSecp256k1({
    privateKey: checkpoint.sessionKey.privateKey,
    root: checkpoint.client,
    chain: environment.chain,
  })
  await sessionKey.syncExpirations([AddPiecesPermission])
  assert(sessionKey.hasPermission(AddPiecesPermission), 'The v1.4.0 session key lost its AddPieces authorization')
  const sessionSynapse = Synapse.create({
    chain: environment.chain,
    transport: http(),
    account: checkpoint.client,
    sessionKey,
    requiredPermissions: [AddPiecesPermission],
    source: 'foc-devnet-synapse-e2e',
  })
  const sessionContext = await sessionSynapse.storage.createContext({ dataSetId: changing.dataSetId })
  const sessionStored = await sessionContext.store(variant(source, 0x07))
  const sessionCommit = await sessionContext.commit({
    pieces: [{ pieceCid: sessionStored.pieceCid }],
    onSubmitted: (hash) => console.log(`Session-key commit submitted: ${hash}`),
  })
  assert.equal(sessionCommit.pieceIds.length, 1, 'The v1.4.0 session key could not add a piece after the transition')

  // FilBeam settles the CDN rails created under v1.4.0.
  await settleCdnExactly(synapse, environment, checkpoint, 3_000n, 4_000n, 'FilBeam settlement after the transition')

  // A new data set can be created through the dispatcher.
  const fresh = await createDataSet(synapse, steady.providerId, [variant(source, 0x08)], 'transition-new', false)
  const freshBytes = await fresh.context.download({ pieceCid: fresh.stored[0].pieceCid })
  assert.equal(freshBytes.byteLength, source.byteLength, 'New data set returned different bytes')

  // Curio's gas for the same steady data set before and after: recorded, not asserted.
  const gas = await provingGas(
    synapse,
    environment,
    steady.dataSetId,
    steady.activationEpoch - steady.maxProvingPeriod,
    transitionBlock
  )
  for (const [event, { before, after: afterGas }] of Object.entries(gas)) {
    console.log(`GAS ${event} before=[${before.join(',')}] after=[${afterGas.join(',')}]`)
  }
  const gasPath = process.env.FWSS_GAS_REPORT
  if (gasPath) writeFileSync(gasPath, JSON.stringify(gas, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2))

  console.log(
    '=== SUCCESS: FWSS transition verified: read parity through proxy and v1.4.0 StateView, static state, old data, proving and exact settlement across the transition, pending removal and unproven piece, presigned signature and replay, session key, CDN settlement, new data set ==='
  )
}

async function main(): Promise<void> {
  const [phase, checkpointPath, filePath] = process.argv.slice(2)
  assert(phase && checkpointPath && filePath, 'Usage: fwss-transition.ts <prepare|arm|continue> <checkpoint> <file>')
  process.argv.splice(2, 2)
  const environment = resolveEnvironment({ defaultUserIndex: 0, requireFiles: true })
  assert.equal(environment.network, 'devnet', 'The FWSS transition scenario is devnet-only')
  const synapse = createSynapse(environment)
  assert.equal(await getChainId(synapse.client), 31_415_926, 'RPC endpoint is not the expected local devnet chain')
  if (phase === 'prepare') await prepare(environment, checkpointPath, filePath)
  else if (phase === 'arm') await arm(environment, checkpointPath, filePath)
  else if (phase === 'continue') await proceed(environment, checkpointPath, filePath)
  else throw new Error(`Unknown phase ${phase}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
