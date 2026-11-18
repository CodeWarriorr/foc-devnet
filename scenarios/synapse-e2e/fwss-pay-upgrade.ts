// Covers every FWSS path that moves money through Filecoin Pay, before and after
// the FWSS upgrade that adds FilecoinPayV2. Data sets created before the upgrade
// keep their FilecoinPayV1 rails ("legacy"); data sets created after it get
// FilecoinPayV2 rails ("v2"). Each behavior is a named step, so one run reports
// all of them; steps listed in FWSS_PAY_PENDING are expected to fail for now.
//
//   node fwss-pay-upgrade.ts prepare  <checkpoint.json> <file>   (baseline, Pay v1 only)
//   node fwss-pay-upgrade.ts continue <checkpoint.json> <file>   (after the upgrade)
//   node fwss-pay-upgrade.ts v2       <checkpoint.json> <file>   (a devnet deployed with Pay v2)
//
// FWSS_PAY_RESULTS names the results file all phases append to.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as ERC20 from '@filoz/synapse-core/erc20'
import { getRail } from '@filoz/synapse-core/pay'
import { getActivePieceCount } from '@filoz/synapse-core/pdp-verifier'
import * as SP from '@filoz/synapse-core/sp'
import { signCreateDataSet } from '@filoz/synapse-core/typed-data'
import { getBlockNumber, getChainId, readContract, sendTransaction, simulateContract } from 'viem/actions'
import {
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Address,
  type Hash,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSynapse, prepareAccount, readAccountState, type ScenarioSynapse } from './account.ts'
import { freshMetadata, resolveEnvironment, type ScenarioEnvironment } from './environment.ts'
import {
  contractsOf,
  createDataSet,
  dataSetRecord,
  delay,
  depositHeadroom,
  expectedProvenGross,
  expectedStorageRate,
  fwssAbi,
  send,
  sendAsFilBeamController,
  settleCdnExactly,
  settleExactly,
  stateViewAbi,
  terminateAsPayer,
  terminateCdnService,
  variant,
  waitForCurrentPeriodEnd,
  waitForNextChallenge,
  waitForPeriodEnd,
  waitForReceipt,
} from './fwss-chain.ts'
import { assertReceiptSucceeded, findRevertErrorName } from './lifecycle-assertions.ts'
import { parsePending, StepRunner } from './pay-steps.ts'
import {
  authorizeV2,
  balanceV2,
  CDN_NONCE_FLAG,
  CREATE_RAIL,
  depositV2,
  FLAG_CALLBACK,
  isV1RailId,
  payV1ExtraAbi,
  payV2Abi,
  payV2Address,
  railCreatedV2,
  railIdV2,
  railStateV2,
  settleV2,
  tokenId,
  v1RailsCreatedSince,
  type RailKey,
} from './pay-v2.ts'

const fwssPayAbi = parseAbi([
  'function paymentsContractAddress() view returns (address)',
  'function filBeamBeneficiaryAddress() view returns (address)',
  'function topUpLifecycleReserve(uint256 dataSetId, uint256 amount)',
  'function topUpCDNPaymentRails(uint256 dataSetId, uint256 cdnAmountToAdd, uint256 cacheMissAmountToAdd)',
  'function terminateService(uint256 dataSetId)',
  'event CDNPaymentRailsToppedUp(uint256 indexed dataSetId, uint256 cdnAmountAdded, uint256 totalCdnLockup, uint256 cacheMissAmountAdded, uint256 totalCacheMissLockup)',
  'event ServiceTerminated(address indexed approver, uint256 indexed dataSetId, uint256 pdpRailId, uint256 cacheMissRailId, uint256 cdnRailId)',
  'error ServiceContractMustTerminateRail()',
  'error InsufficientLockupFunds(address payer, uint256 required, uint256 available)',
  'error DataSetPaymentAlreadyTerminated(uint256 dataSetId)',
])

const pdpCreateAbi = parseAbi([
  'function createDataSet(address listenerAddr, bytes extraData) payable returns (uint256)',
  'error InsufficientLockupFunds(address payer, uint256 required, uint256 available)',
  'error Unauthorized(address user, address operator)',
])

const RESERVE_TOP_UP = parseUnits('0.01', 18)
const CDN_TOP_UP = parseUnits('0.02', 18)
const V2_DEPOSIT = parseUnits('5', 18)

type DataSetRef = {
  dataSetId: bigint
  providerId: bigint
  pdpRailId: bigint
  payee: Address
  cdnRailId: bigint
  cacheMissRailId: bigint
  pieceCids: string[]
}

type Checkpoint = {
  client: Address
  fwss: Address
  payV1: Address
  token: Address
  steady?: DataSetRef & { settledUpTo: bigint }
  cdn?: DataSetRef
  terminating?: DataSetRef
  terminated?: DataSetRef & { endEpoch: bigint }
  v1RailCount?: bigint
}

type Context = {
  environment: ScenarioEnvironment
  synapse: ScenarioSynapse
  runner: StepRunner
  checkpoint: Checkpoint
  source: Uint8Array
}

function saveCheckpoint(path: string, checkpoint: Checkpoint): void {
  writeFileSync(path, JSON.stringify(checkpoint, (_, v) => (typeof v === 'bigint' ? `${v}n` : v), 2))
}

function loadCheckpoint(path: string): Checkpoint {
  return JSON.parse(readFileSync(path, 'utf8'), (_, v) =>
    typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
  )
}

function requiredBigInt(name: string): bigint {
  const value = process.env[name]
  assert(value != null && /^\d+$/.test(value), `${name} must be a block number`)
  return BigInt(value)
}

async function fwssInfo(ctx: Context, dataSetId: bigint) {
  return readContract(ctx.synapse.client, {
    address: contractsOf(ctx.environment).fwssStateView,
    abi: stateViewAbi,
    functionName: 'getDataSet',
    args: [dataSetId],
  })
}

async function firstProvider(synapse: ScenarioSynapse) {
  const providers = await synapse.providers.getAllActiveProviders()
  assert(providers.length > 0, 'No active PDP provider is available')
  return providers[0]
}

async function asRef(ctx: Context, dataSetId: bigint, providerId: bigint, pieceCids: string[]): Promise<DataSetRef> {
  const record = await dataSetRecord(ctx.synapse, ctx.environment, dataSetId)
  return {
    dataSetId,
    providerId,
    pdpRailId: record.pdpRailId,
    payee: record.payee,
    cdnRailId: record.cdnRailId,
    cacheMissRailId: record.cacheMissRailId,
    pieceCids,
  }
}

/** Expects a simulated call to revert with `expected`; any other outcome fails. */
async function expectRevert(run: () => Promise<unknown>, expected: string, label: string): Promise<void> {
  try {
    await run()
  } catch (error) {
    assert.equal(findRevertErrorName(error), expected, `${label} reverted for another reason`)
    return
  }
  throw new Error(`${label} was accepted`)
}

async function addPiece(ctx: Context, ref: DataSetRef, tag: number, label: string): Promise<string> {
  const context = await ctx.synapse.storage.createContext({ providerId: ref.providerId, dataSetId: ref.dataSetId })
  const stored = await context.store(variant(ctx.source, tag))
  const committed = await context.commit({
    pieces: [{ pieceCid: stored.pieceCid }],
    onSubmitted: (hash) => console.log(`${label} commit submitted: ${hash}`),
  })
  assert.equal(committed.pieceIds.length, 1, `${label} did not confirm the piece`)
  return stored.pieceCid.toString()
}

async function schedulePieceRemoval(ctx: Context, ref: DataSetRef, pieceCid: string, label: string) {
  const context = await ctx.synapse.storage.createContext({ providerId: ref.providerId, dataSetId: ref.dataSetId })
  const before = await activePieces(ctx, ref.dataSetId)
  const hash = (await context.deletePiece({ piece: pieceCid })) as Hash
  assertReceiptSucceeded(await waitForReceipt(ctx.synapse, hash, label), label)
  assert.equal((await context.getScheduledRemovals()).length, 1, `${label}: no removal is scheduled`)
  return before
}

async function activePieces(ctx: Context, dataSetId: bigint): Promise<bigint> {
  return getActivePieceCount(ctx.synapse.client, { dataSetId, contractAddress: contractsOf(ctx.environment).pdpVerifier })
}

/** Waits until the scheduled removal took effect and the next challenge is set, after which FWSS has repriced. */
async function waitForRemoval(ctx: Context, dataSetId: bigint, expectedPieces: bigint): Promise<void> {
  const started = Date.now()
  const timeout = Number(process.env.FWSS_PROOF_TIMEOUT_MS ?? 900_000)
  while ((await activePieces(ctx, dataSetId)) !== expectedPieces) {
    assert(Date.now() - started < timeout, `Data set ${dataSetId} did not drop to ${expectedPieces} pieces`)
    await delay(5_000)
  }
  await waitForNextChallenge(ctx.synapse, ctx.environment, dataSetId)
}

/** Waits for the next period of `dataSetId` that FWSS records as proven, from the one holding the head. */
async function waitForProvenPeriodEnd(ctx: Context, dataSetId: bigint) {
  let period = await waitForCurrentPeriodEnd(ctx.synapse, ctx.environment, dataSetId)
  for (let attempt = 0; attempt < 3 && !period.proven; attempt++) {
    const next = (period.deadline - period.activationEpoch) / period.maxProvingPeriod
    period = await waitForPeriodEnd(ctx.environment, dataSetId, next)
  }
  assert(period.proven, `Data set ${dataSetId} proved none of four periods`)
  return period
}

// ── FilecoinPayV1 (baseline and legacy data sets) ────────────

async function v1OperatorApproval(ctx: Context) {
  const [isApproved, rateAllowance, lockupAllowance] = await readContract(ctx.synapse.client, {
    address: ctx.checkpoint.payV1,
    abi: payV1ExtraAbi,
    functionName: 'operatorApprovals',
    args: [ctx.checkpoint.token, ctx.checkpoint.client, ctx.checkpoint.fwss],
  })
  return { isApproved, rateAllowance, lockupAllowance }
}

async function v1RailCount(ctx: Context): Promise<bigint> {
  const [, , total] = await readContract(ctx.synapse.client, {
    address: ctx.checkpoint.payV1,
    abi: payV1ExtraAbi,
    functionName: 'getRailsForPayerAndToken',
    args: [ctx.checkpoint.client, ctx.checkpoint.token, 0n, 1n],
  })
  return total
}

/** The PDP rail's v1 terms: FWSS operates and validates it, and its rate follows the data set's size. */
async function assertV1PdpRail(ctx: Context, ref: DataSetRef, label: string): Promise<void> {
  assert(isV1RailId(ref.pdpRailId), `${label}: PDP rail ${ref.pdpRailId} is not a FilecoinPayV1 rail id`)
  const [rail, info, { expectedRate }] = await Promise.all([
    getRail(ctx.synapse.client, { railId: ref.pdpRailId }),
    fwssInfo(ctx, ref.dataSetId),
    expectedStorageRate(ctx.synapse, ctx.environment, ref.dataSetId),
  ])
  assert.equal(rail.from, ctx.checkpoint.client, `${label}: rail payer`)
  assert.equal(rail.to, ref.payee, `${label}: rail payee`)
  assert.equal(rail.operator, ctx.checkpoint.fwss, `${label}: rail operator`)
  assert.equal(rail.validator, ctx.checkpoint.fwss, `${label}: rail validator`)
  assert.equal(rail.paymentRate, expectedRate, `${label}: rail rate differs from size and price`)
  assert.equal(rail.lockupFixed, info.lifecycleReserveBalance, `${label}: rail lockup differs from the FWSS reserve`)
}

async function assertV1CdnRails(ctx: Context, ref: DataSetRef, label: string): Promise<void> {
  assert(isV1RailId(ref.cdnRailId) && isV1RailId(ref.cacheMissRailId), `${label}: CDN rails are not FilecoinPayV1 rails`)
  const beneficiary = await readContract(ctx.synapse.client, {
    address: ctx.checkpoint.fwss,
    abi: fwssPayAbi,
    functionName: 'filBeamBeneficiaryAddress',
  })
  const [cdn, cacheMiss] = await Promise.all([
    getRail(ctx.synapse.client, { railId: ref.cdnRailId }),
    getRail(ctx.synapse.client, { railId: ref.cacheMissRailId }),
  ])
  for (const [rail, payee, name] of [
    [cdn, beneficiary, 'CDN'],
    [cacheMiss, ref.payee, 'cache-miss'],
  ] as const) {
    assert.equal(rail.to, payee, `${label}: ${name} rail payee`)
    assert.equal(rail.operator, ctx.checkpoint.fwss, `${label}: ${name} rail operator`)
    assert.equal(rail.validator, zeroAddress, `${label}: ${name} rail has a validator`)
    assert.equal(rail.paymentRate, 0n, `${label}: ${name} rail streams`)
    assert(rail.lockupFixed > 0n, `${label}: ${name} rail has no lockup`)
  }
}

async function topUpReserveV1(ctx: Context, ref: DataSetRef, label: string): Promise<void> {
  const [railBefore, infoBefore] = await Promise.all([
    getRail(ctx.synapse.client, { railId: ref.pdpRailId }),
    fwssInfo(ctx, ref.dataSetId),
  ])
  await topUpReserve(ctx, ref.dataSetId, label)
  const [railAfter, infoAfter] = await Promise.all([
    getRail(ctx.synapse.client, { railId: ref.pdpRailId }),
    fwssInfo(ctx, ref.dataSetId),
  ])
  assert.equal(railAfter.lockupFixed - railBefore.lockupFixed, RESERVE_TOP_UP, `${label}: rail lockup did not grow by the top-up`)
  assert.equal(
    infoAfter.lifecycleReserveBalance - infoBefore.lifecycleReserveBalance,
    RESERVE_TOP_UP,
    `${label}: FWSS reserve did not grow by the top-up`
  )
}

async function topUpCdnV1(ctx: Context, ref: DataSetRef, label: string): Promise<void> {
  const before = await Promise.all([ref.cdnRailId, ref.cacheMissRailId].map((railId) => getRail(ctx.synapse.client, { railId })))
  await topUpCdn(ctx, ref.dataSetId, label)
  const after = await Promise.all([ref.cdnRailId, ref.cacheMissRailId].map((railId) => getRail(ctx.synapse.client, { railId })))
  assert.equal(after[0].lockupFixed - before[0].lockupFixed, CDN_TOP_UP, `${label}: CDN lockup did not grow`)
  assert.equal(after[1].lockupFixed - before[1].lockupFixed, CDN_TOP_UP, `${label}: cache-miss lockup did not grow`)
}

/** FilecoinPayV1 asks FWSS before a payer ends a PDP rail itself, and FWSS refuses, so termination goes through FWSS. */
async function assertV1PayerCannotTerminate(ctx: Context, ref: DataSetRef): Promise<void> {
  await expectRevert(
    () =>
      simulateContract(ctx.synapse.client, {
        account: ctx.synapse.client.account,
        address: ctx.checkpoint.payV1,
        abi: [...payV1ExtraAbi, ...fwssPayAbi],
        functionName: 'terminateRail',
        args: [ref.pdpRailId],
      }),
    'ServiceContractMustTerminateRail',
    'Payer termination of the PDP rail on FilecoinPayV1'
  )
}

async function withdrawV1(ctx: Context, label: string): Promise<void> {
  const amount = parseUnits('0.001', 18)
  const [account, walletBefore] = await Promise.all([
    readAccountState(ctx.synapse),
    ERC20.balance(ctx.synapse.client, { address: ctx.checkpoint.client }),
  ])
  assert(account.availableFunds >= amount, `${label}: only ${account.availableFunds} is unlocked`)
  const { request } = await simulateContract(ctx.synapse.client, {
    account: ctx.synapse.client.account,
    address: ctx.checkpoint.payV1,
    abi: payV1ExtraAbi,
    functionName: 'withdraw',
    args: [ctx.checkpoint.token, amount],
  })
  await send(ctx.synapse, request, label)
  const walletAfter = await ERC20.balance(ctx.synapse.client, { address: ctx.checkpoint.client })
  assert.equal(walletAfter.value - walletBefore.value, amount, `${label}: wallet did not receive the withdrawal`)
}

// ── FWSS calls shared by both Pay versions ───────────────────

async function topUpReserve(ctx: Context, dataSetId: bigint, label: string) {
  const { request } = await simulateContract(ctx.synapse.client, {
    account: ctx.synapse.client.account,
    address: ctx.checkpoint.fwss,
    abi: fwssPayAbi,
    functionName: 'topUpLifecycleReserve',
    args: [dataSetId, RESERVE_TOP_UP],
  })
  return send(ctx.synapse, request, label)
}

async function topUpCdn(ctx: Context, dataSetId: bigint, label: string) {
  const { request } = await simulateContract(ctx.synapse.client, {
    account: ctx.synapse.client.account,
    address: ctx.checkpoint.fwss,
    abi: fwssPayAbi,
    functionName: 'topUpCDNPaymentRails',
    args: [dataSetId, CDN_TOP_UP, CDN_TOP_UP],
  })
  const receipt = await send(ctx.synapse, request, label)
  const events = parseEventLogs({ abi: fwssPayAbi, logs: receipt.logs, eventName: 'CDNPaymentRailsToppedUp', strict: true })
  assert.equal(events.length, 1, `${label}: receipt must contain one CDNPaymentRailsToppedUp event`)
  assert.deepEqual(
    [events[0].args.dataSetId, events[0].args.cdnAmountAdded, events[0].args.cacheMissAmountAdded],
    [dataSetId, CDN_TOP_UP, CDN_TOP_UP],
    `${label}: CDNPaymentRailsToppedUp names other amounts`
  )
  return receipt
}

// ── FilecoinPayV2 (data sets created after the upgrade) ──────

function requirePayV2(): Address {
  const pay = payV2Address()
  assert(pay != null, 'No FilecoinPayV2 address: set FILECOIN_PAY_V2_ADDRESS or deploy filecoin-services with Pay v2')
  return pay
}

function v2Keys(ctx: Context, ref: DataSetRef, beneficiary: Address) {
  const base = { operator: ctx.checkpoint.fwss, from: ctx.checkpoint.client, token: ctx.checkpoint.token }
  return {
    pdp: { ...base, recipient: ref.payee, nonce: FLAG_CALLBACK | ref.dataSetId } satisfies RailKey,
    cacheMiss: { ...base, recipient: ref.payee, nonce: ref.dataSetId } satisfies RailKey,
    cdn: { ...base, recipient: beneficiary, nonce: CDN_NONCE_FLAG | ref.dataSetId } satisfies RailKey,
  }
}

async function beneficiaryOf(ctx: Context): Promise<Address> {
  return readContract(ctx.synapse.client, { address: ctx.checkpoint.fwss, abi: fwssPayAbi, functionName: 'filBeamBeneficiaryAddress' })
}

/** Creates an empty data set through Curio and checks every rail it opened on FilecoinPayV2, and none on v1. */
async function createV2DataSet(ctx: Context, pay: Address, withCDN: boolean, label: string): Promise<DataSetRef> {
  const provider = await firstProvider(ctx.synapse)
  const client = ctx.checkpoint.client
  const balanceBefore = await balanceV2(ctx.synapse, pay, client, ctx.checkpoint.token)
  const created = await SP.createDataSet(ctx.synapse.client, {
    cdn: withCDN,
    payee: provider.serviceProvider,
    payer: client,
    serviceURL: provider.pdp.serviceURL,
    recordKeeper: ctx.checkpoint.fwss,
    metadata: freshMetadata(label),
  })
  console.log(`${label} submitted: ${created.txHash}`)
  const confirmed = await SP.waitForCreateDataSet({ client: ctx.synapse.client, ...created, timeout: 180_000 })
  const receipt = await waitForReceipt(ctx.synapse, created.txHash as Hash, label)
  const ref = await asRef(ctx, confirmed.dataSetId, provider.id, [])
  const keys = v2Keys(ctx, ref, await beneficiaryOf(ctx))

  assert(!isV1RailId(ref.pdpRailId), `${label}: PDP rail ${ref.pdpRailId} is a FilecoinPayV1 rail id`)
  assert.equal(ref.pdpRailId, railIdV2(keys.pdp), `${label}: PDP rail id is not FWSS's v2 rail for this data set`)
  const created2 = railCreatedV2(receipt, pay)
  const expectedRails = withCDN ? [keys.pdp, keys.cacheMiss, keys.cdn] : [keys.pdp]
  assert.equal(created2.length, expectedRails.length, `${label}: FilecoinPayV2 opened ${created2.length} rails`)
  for (const key of expectedRails) {
    const event = created2.find((log) => log.args.nonce === key.nonce)
    assert(event != null, `${label}: no RailCreated with nonce ${key.nonce}`)
    assert.deepEqual(
      [event.args.payer, event.args.payee, event.args.operator, event.args.token, event.args.railId],
      [key.from, key.recipient, key.operator, tokenId(key.token), railIdV2(key)],
      `${label}: RailCreated for nonce ${key.nonce} names another rail`
    )
  }
  const v1Created = parseEventLogs({ abi: payV1ExtraAbi, logs: receipt.logs, eventName: 'RailCreated', strict: false })
  assert.equal(v1Created.length, 0, `${label}: the creation also opened FilecoinPayV1 rails`)

  const info = await fwssInfo(ctx, ref.dataSetId)
  const pdp = await railStateV2(ctx.synapse, pay, ref.pdpRailId)
  assert(pdp.settledUpTo > 0n, `${label}: PDP rail does not exist on FilecoinPayV2`)
  assert.equal(pdp.incomingRate, 0n, `${label}: an empty data set's rail streams`)
  assert.equal(pdp.available, info.lifecycleReserveBalance, `${label}: PDP lockup differs from the FWSS reserve`)
  let locked = pdp.available
  if (withCDN) {
    assert.equal(ref.cacheMissRailId, railIdV2(keys.cacheMiss), `${label}: cache-miss rail id`)
    assert.equal(ref.cdnRailId, railIdV2(keys.cdn), `${label}: CDN rail id`)
    const topUps = parseEventLogs({ abi: fwssPayAbi, logs: receipt.logs, eventName: 'CDNPaymentRailsToppedUp', strict: true })
    assert.equal(topUps.length, 1, `${label}: expected one CDNPaymentRailsToppedUp`)
    const [cacheMiss, cdn] = await Promise.all([
      railStateV2(ctx.synapse, pay, ref.cacheMissRailId),
      railStateV2(ctx.synapse, pay, ref.cdnRailId),
    ])
    assert.equal(cdn.available, topUps[0].args.totalCdnLockup, `${label}: CDN lockup`)
    assert.equal(cacheMiss.available, topUps[0].args.totalCacheMissLockup, `${label}: cache-miss lockup`)
    locked += cdn.available + cacheMiss.available
  } else {
    assert.equal(ref.cdnRailId, 0n, `${label}: a data set without CDN has a CDN rail`)
  }
  const balanceAfter = await balanceV2(ctx.synapse, pay, client, ctx.checkpoint.token)
  assert.equal(balanceBefore - balanceAfter, locked, `${label}: payer balance did not fund exactly the lockups`)
  console.log(`${label}: data set ${ref.dataSetId}, PDP rail ${ref.pdpRailId}, locked ${locked}`)
  return ref
}

/** Simulates the provider creating a data set for `signer` and requires `expected` from FWSS or FilecoinPayV2. */
async function assertV2CreateRejected(ctx: Context, signer: `0x${string}`, expected: string, label: string) {
  const provider = await firstProvider(ctx.synapse)
  const wallet = createWalletClient({ account: privateKeyToAccount(signer), chain: ctx.environment.chain, transport: http() })
  const extraData = await signCreateDataSet(wallet, { payee: provider.serviceProvider, metadata: [] })
  await expectRevert(
    () =>
      simulateContract(ctx.synapse.client, {
        account: provider.serviceProvider,
        address: contractsOf(ctx.environment).pdpVerifier,
        abi: pdpCreateAbi,
        functionName: 'createDataSet',
        args: [ctx.checkpoint.fwss, extraData],
        value: parseUnits('1', 18),
      }),
    expected,
    label
  )
}

/** Gross a constant-rate rail earns over (from, to] in the data set's proven periods. */
async function provenGross(ctx: Context, dataSetId: bigint, rate: bigint, from: bigint, to: bigint): Promise<bigint> {
  const contracts = contractsOf(ctx.environment)
  const [[maxProvingPeriod], activation] = await Promise.all([
    readContract(ctx.synapse.client, { address: contracts.fwssStateView, abi: stateViewAbi, functionName: 'getPDPConfig' }),
    readContract(ctx.synapse.client, {
      address: contracts.fwssStateView,
      abi: stateViewAbi,
      functionName: 'provingActivationEpoch',
      args: [dataSetId],
    }),
  ])
  let gross = 0n
  let start = from > activation ? from : activation
  while (start < to) {
    const period = (start - activation) / maxProvingPeriod
    const deadline = activation + (period + 1n) * maxProvingPeriod
    const end = deadline < to ? deadline : to
    const proven = await readContract(ctx.synapse.client, {
      address: contracts.fwssStateView,
      abi: stateViewAbi,
      functionName: 'provenPeriods',
      args: [dataSetId, period],
    })
    if (proven) gross += rate * (end - start)
    start = end
  }
  return gross
}

// ── Phases ───────────────────────────────────────────────────

async function prepare(ctx: Context, checkpointPath: string): Promise<void> {
  const { runner, synapse, environment } = ctx
  const provider = await firstProvider(synapse)
  const save = () => saveCheckpoint(checkpointPath, ctx.checkpoint)
  save()

  await runner.run('v1.account.setup', [], async () => {
    await prepareAccount(synapse, BigInt(ctx.source.byteLength))
    await depositHeadroom(synapse)
    const approval = await v1OperatorApproval(ctx)
    assert(approval.isApproved, 'FWSS is not an approved FilecoinPayV1 operator')
    assert(approval.rateAllowance > 0n && approval.lockupAllowance > 0n, 'FWSS has no FilecoinPayV1 allowance')
  })

  ctx.checkpoint.steady = await runner.run('v1.create.storage', ['v1.account.setup'], async () => {
    const { committed, stored } = await createDataSet(synapse, provider.id, [ctx.source], 'pay-steady', false)
    const ref = await asRef(ctx, committed.dataSetId, provider.id, [stored[0].pieceCid.toString()])
    await assertV1PdpRail(ctx, ref, 'Storage data set')
    assert.equal(ref.cdnRailId, 0n, 'A data set without CDN has a CDN rail')
    return { ...ref, settledUpTo: (await getRail(synapse.client, { railId: ref.pdpRailId })).settledUpTo }
  })
  save()

  ctx.checkpoint.cdn = await runner.run('v1.create.cdn', ['v1.account.setup'], async () => {
    const { committed, stored } = await createDataSet(synapse, provider.id, [variant(ctx.source, 0x11)], 'pay-cdn', true)
    const ref = await asRef(ctx, committed.dataSetId, provider.id, [stored[0].pieceCid.toString()])
    await assertV1PdpRail(ctx, ref, 'CDN data set')
    await assertV1CdnRails(ctx, ref, 'CDN data set')
    return ref
  })
  save()

  ctx.checkpoint.terminating = await runner.run('v1.create.terminating', ['v1.account.setup'], async () => {
    const { committed, stored } = await createDataSet(synapse, provider.id, [variant(ctx.source, 0x12)], 'pay-terminating', false)
    return asRef(ctx, committed.dataSetId, provider.id, [stored[0].pieceCid.toString()])
  })
  save()

  ctx.checkpoint.terminated = await runner.run('v1.terminate.payer', ['v1.account.setup'], async () => {
    const { committed, stored } = await createDataSet(synapse, provider.id, [variant(ctx.source, 0x13)], 'pay-terminated', false)
    const ref = await asRef(ctx, committed.dataSetId, provider.id, [stored[0].pieceCid.toString()])
    return { ...ref, endEpoch: await terminateAsPayer(synapse, environment, ref.dataSetId) }
  })
  save()

  await runner.run('v1.pdp-rail.payer-cannot-bypass-fwss', ['v1.create.storage'], () =>
    assertV1PayerCannotTerminate(ctx, ctx.checkpoint.steady!)
  )

  await runner.run('v1.reserve.top-up', ['v1.create.storage'], () =>
    topUpReserveV1(ctx, ctx.checkpoint.steady!, 'Lifecycle reserve top-up')
  )

  await runner.run('v1.cdn.settle', ['v1.create.cdn'], () =>
    settleCdnExactly(synapse, environment, ctx.checkpoint.cdn!, 1_000n, 2_000n, 'FilBeam settlement on Pay v1')
  )
  await runner.run('v1.cdn.top-up', ['v1.create.cdn'], () => topUpCdnV1(ctx, ctx.checkpoint.cdn!, 'CDN top-up on Pay v1'))

  await runner.run('v1.settle.proven', ['v1.create.storage'], async () => {
    const steady = ctx.checkpoint.steady!
    const period = await waitForProvenPeriodEnd(ctx, steady.dataSetId)
    const { gross } = await expectedProvenGross(
      synapse,
      environment,
      steady.dataSetId,
      steady.pdpRailId,
      steady.settledUpTo,
      period.deadline
    )
    assert(gross > 0n, 'A proven period paid nothing')
    await settleExactly(synapse, environment, steady.pdpRailId, period.deadline, gross, 'Pay v1 settlement before the upgrade')
    steady.settledUpTo = period.deadline
  })
  save()

  await runner.run('v1.withdraw', ['v1.account.setup'], () => withdrawV1(ctx, 'Pay v1 withdrawal before the upgrade'))

  ctx.checkpoint.v1RailCount = await v1RailCount(ctx)
  save()
}

async function proceed(ctx: Context, upgradeBlock: bigint | undefined): Promise<void> {
  const { runner, synapse, environment, checkpoint } = ctx
  const legacy = upgradeBlock != null
  const steady = checkpoint.steady
  const cdn = checkpoint.cdn

  if (legacy) {
    await runner.run('legacy.state', ['v1.create.storage'], async () => {
      const payments = await readContract(synapse.client, {
        address: checkpoint.fwss,
        abi: fwssPayAbi,
        functionName: 'paymentsContractAddress',
      })
      assert.equal(payments, checkpoint.payV1, 'FWSS reports another FilecoinPayV1 address')
      for (const ref of [steady, cdn, checkpoint.terminating, checkpoint.terminated]) {
        if (ref == null) continue
        const now = await asRef(ctx, ref.dataSetId, ref.providerId, ref.pieceCids)
        assert.deepEqual(
          [now.pdpRailId, now.cdnRailId, now.cacheMissRailId, now.payee],
          [ref.pdpRailId, ref.cdnRailId, ref.cacheMissRailId, ref.payee],
          `Data set ${ref.dataSetId} changed its rails in the upgrade`
        )
      }
      await assertV1PdpRail(ctx, steady!, 'Storage data set after the upgrade')
      if (cdn != null) await assertV1CdnRails(ctx, cdn, 'CDN data set after the upgrade')
      const terminated = checkpoint.terminated
      if (terminated != null) {
        const rail = await getRail(synapse.client, { railId: terminated.pdpRailId })
        assert.equal(rail.endEpoch, terminated.endEpoch, 'The terminated rail end changed in the upgrade')
      }
    })
  }

  // New data sets: the payer funds FilecoinPayV2 and lets FWSS open rails there.
  const pay = await runner.run('v2.address', [], async () => {
    const address = requirePayV2()
    const code = await synapse.client.request({ method: 'eth_getCode', params: [address, 'latest'] })
    assert(code !== '0x', `FilecoinPayV2 ${address} has no code`)
    return address
  })

  await runner.run('v2.account.setup', ['v2.address'], async () => {
    await depositV2(synapse, pay!, checkpoint.token, V2_DEPOSIT)
    await authorizeV2(synapse, pay!, checkpoint.fwss, CREATE_RAIL)
  })

  await runner.run('v2.create.rejected-unfunded', ['v2.address'], () =>
    assertV2CreateRejected(ctx, generatePrivateKey(), 'InsufficientLockupFunds', 'Creation for a payer without v2 funds')
  )

  await runner.run('v2.create.rejected-unauthorized', ['v2.address'], async () => {
    // A funded payer that never authorized FWSS.
    const key = generatePrivateKey()
    const stranger = privateKeyToAccount(key)
    const gas = await sendTransaction(synapse.client, {
      account: synapse.client.account,
      chain: environment.chain,
      to: stranger.address,
      value: parseUnits('1', 18),
    })
    assertReceiptSucceeded(await waitForReceipt(synapse, gas, 'Stranger FIL'), 'Stranger FIL')
    const usdfc = await simulateContract(synapse.client, {
      account: synapse.client.account,
      address: checkpoint.token,
      abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args: [stranger.address, V2_DEPOSIT],
    })
    await send(synapse, usdfc.request, 'Stranger USDFC')
    const strangerSynapse = createSynapse({ ...ctx.environment, privateKey: key, user: undefined })
    await depositV2(strangerSynapse, pay!, checkpoint.token, V2_DEPOSIT)
    await assertV2CreateRejected(ctx, key, 'Unauthorized', 'Creation for a payer that did not authorize FWSS')
  })

  const storage = await runner.run('v2.create.storage', ['v2.account.setup'], () =>
    createV2DataSet(ctx, pay!, false, 'pay-v2-storage')
  )
  const cdnV2 = await runner.run('v2.create.cdn', ['v2.account.setup'], () => createV2DataSet(ctx, pay!, true, 'pay-v2-cdn'))

  // Pieces change the rate on each data set's own Pay version.
  if (legacy) {
    await runner.run('legacy.add-pieces', ['legacy.state'], async () => {
      const before = await getRail(synapse.client, { railId: steady!.pdpRailId })
      steady!.pieceCids.push(await addPiece(ctx, steady!, 0x21, 'Legacy add'))
      await assertV1PdpRail(ctx, steady!, 'Legacy data set after an add')
      const after = await getRail(synapse.client, { railId: steady!.pdpRailId })
      assert(after.paymentRate > before.paymentRate, 'Adding a piece did not raise the v1 rate')
    })
  }
  await runner.run('v2.add-pieces', ['v2.create.storage'], async () => {
    storage!.pieceCids.push(await addPiece(ctx, storage!, 0x31, 'V2 add'))
    storage!.pieceCids.push(await addPiece(ctx, storage!, 0x32, 'V2 second add'))
    const [state, { expectedRate }] = await Promise.all([
      railStateV2(synapse, pay!, storage!.pdpRailId),
      expectedStorageRate(synapse, environment, storage!.dataSetId),
    ])
    assert.equal(state.incomingRate, expectedRate, 'V2 rail rate differs from size and price')
    assert(expectedRate > 0n, 'V2 data set with pieces has a zero rate')
  })

  if (legacy) {
    await runner.run('legacy.reserve.top-up', ['legacy.state'], () =>
      topUpReserveV1(ctx, steady!, 'Legacy lifecycle reserve top-up')
    )
  }
  await runner.run('v2.reserve.top-up', ['v2.create.storage'], async () => {
    const [before, balanceBefore] = await Promise.all([
      railStateV2(synapse, pay!, storage!.pdpRailId),
      balanceV2(synapse, pay!, checkpoint.client, checkpoint.token),
    ])
    await topUpReserve(ctx, storage!.dataSetId, 'V2 lifecycle reserve top-up')
    const [after, balanceAfter, info] = await Promise.all([
      railStateV2(synapse, pay!, storage!.pdpRailId),
      balanceV2(synapse, pay!, checkpoint.client, checkpoint.token),
      fwssInfo(ctx, storage!.dataSetId),
    ])
    assert.equal(after.available - before.available, RESERVE_TOP_UP, 'V2 PDP lockup did not grow by the top-up')
    assert(balanceBefore - balanceAfter >= RESERVE_TOP_UP, 'V2 payer balance did not fund the top-up')
    assert.equal(after.available, info.lifecycleReserveBalance, 'V2 PDP lockup differs from the FWSS reserve')
  })

  if (legacy && cdn != null) {
    await runner.run('legacy.cdn.settle', ['legacy.state'], () =>
      settleCdnExactly(synapse, environment, cdn, 3_000n, 4_000n, 'FilBeam settlement of a legacy data set')
    )
    await runner.run('legacy.cdn.top-up', ['legacy.state'], () => topUpCdnV1(ctx, cdn, 'Legacy CDN top-up'))
  }
  await runner.run('v2.cdn.settle', ['v2.create.cdn'], async () => {
    const beneficiary = await beneficiaryOf(ctx)
    const ids = [cdnV2!.cdnRailId, cdnV2!.cacheMissRailId]
    const before = await Promise.all(ids.map((id) => railStateV2(synapse, pay!, id)))
    const payeesBefore = await Promise.all(
      [beneficiary, cdnV2!.payee].map((who) => balanceV2(synapse, pay!, who, checkpoint.token))
    )
    await sendAsFilBeamController(
      synapse,
      environment,
      'settleFilBeamPaymentRails',
      [cdnV2!.dataSetId, 300n, 400n],
      'FilBeam settlement on Pay v2'
    )
    const after = await Promise.all(ids.map((id) => railStateV2(synapse, pay!, id)))
    const payeesAfter = await Promise.all(
      [beneficiary, cdnV2!.payee].map((who) => balanceV2(synapse, pay!, who, checkpoint.token))
    )
    assert.equal(before[0].available - after[0].available, 300n, 'V2 CDN lockup was not drawn by its payment')
    assert.equal(before[1].available - after[1].available, 400n, 'V2 cache-miss lockup was not drawn by its payment')
    if (beneficiary === cdnV2!.payee) {
      assert.equal(payeesAfter[0] - payeesBefore[0], 700n, 'V2 FilBeam payee credit')
    } else {
      assert.equal(payeesAfter[0] - payeesBefore[0], 300n, 'V2 CDN payee credit')
      assert.equal(payeesAfter[1] - payeesBefore[1], 400n, 'V2 cache-miss payee credit')
    }
  })
  await runner.run('v2.cdn.top-up', ['v2.create.cdn'], async () => {
    const ids = [cdnV2!.cdnRailId, cdnV2!.cacheMissRailId]
    const before = await Promise.all(ids.map((id) => railStateV2(synapse, pay!, id)))
    await topUpCdn(ctx, cdnV2!.dataSetId, 'V2 CDN top-up')
    const after = await Promise.all(ids.map((id) => railStateV2(synapse, pay!, id)))
    assert.equal(after[0].available - before[0].available, CDN_TOP_UP, 'V2 CDN lockup did not grow')
    assert.equal(after[1].available - before[1].available, CDN_TOP_UP, 'V2 cache-miss lockup did not grow')
  })

  // Proven periods pay the provider on both Pay versions.
  if (legacy) {
    await runner.run('legacy.settle.across-upgrade', ['legacy.state', 'v1.settle.proven'], async () => {
      const period = await waitForProvenPeriodEnd(ctx, steady!.dataSetId)
      assert(period.deadline > upgradeBlock, 'The settled range does not reach past the upgrade')
      const { gross } = await expectedProvenGross(
        synapse,
        environment,
        steady!.dataSetId,
        steady!.pdpRailId,
        steady!.settledUpTo,
        period.deadline
      )
      await settleExactly(synapse, environment, steady!.pdpRailId, period.deadline, gross, 'Legacy settlement across the upgrade')
      steady!.settledUpTo = period.deadline
    })
    await runner.run('legacy.terminated.settle', ['legacy.state', 'v1.terminate.payer'], async () => {
      const terminated = checkpoint.terminated!
      const period = await waitForCurrentPeriodEnd(synapse, environment, terminated.dataSetId)
      const rail = await getRail(synapse.client, { railId: terminated.pdpRailId })
      const target = period.deadline < terminated.endEpoch ? period.deadline : terminated.endEpoch
      const { gross } = await expectedProvenGross(
        synapse,
        environment,
        terminated.dataSetId,
        terminated.pdpRailId,
        rail.settledUpTo,
        target
      )
      await settleExactly(synapse, environment, terminated.pdpRailId, target, gross, 'Settlement of a rail terminated before the upgrade')
    })
  }
  await runner.run('v2.settle.proven', ['v2.add-pieces'], async () => {
    const key = v2Keys(ctx, storage!, await beneficiaryOf(ctx)).pdp
    const before = await railStateV2(synapse, pay!, storage!.pdpRailId)
    const period = await waitForProvenPeriodEnd(ctx, storage!.dataSetId)
    const payeeBefore = await balanceV2(synapse, pay!, storage!.payee, checkpoint.token)
    const { settledUpTo } = await settleV2(synapse, pay!, key)
    const after = await railStateV2(synapse, pay!, storage!.pdpRailId)
    const payeeAfter = await balanceV2(synapse, pay!, storage!.payee, checkpoint.token)
    assert.equal(after.settledUpTo, settledUpTo, 'V2 rail cursor differs from the settlement result')
    assert(settledUpTo >= period.deadline, 'V2 settlement stopped before the proven period ended')
    // FWSS pays proven epochs only, as on v1. Pay v2 takes no network fee in the code read so far; tighten
    // this once FWSS's IRailV2.settleRail lands and its fee and commission rules are known.
    const gross = await provenGross(ctx, storage!.dataSetId, before.incomingRate, before.settledUpTo, settledUpTo)
    assert(gross > 0n, 'The settled range holds no proven epoch')
    assert.equal(payeeAfter - payeeBefore, gross, 'V2 payee credit differs from the proven epochs at the rail rate')
  })

  // Removing pieces lowers the rate on each data set's own Pay version.
  if (legacy) {
    await runner.run('legacy.remove-piece', ['legacy.add-pieces'], async () => {
      const before = await getRail(synapse.client, { railId: steady!.pdpRailId })
      const pieces = await schedulePieceRemoval(ctx, steady!, steady!.pieceCids.at(-1)!, 'Legacy piece removal')
      await waitForRemoval(ctx, steady!.dataSetId, pieces - 1n)
      await assertV1PdpRail(ctx, steady!, 'Legacy data set after a removal')
      const after = await getRail(synapse.client, { railId: steady!.pdpRailId })
      assert(after.paymentRate < before.paymentRate, 'Removing a piece did not lower the v1 rate')
    })
  }
  await runner.run('v2.remove-piece', ['v2.add-pieces'], async () => {
    const before = await railStateV2(synapse, pay!, storage!.pdpRailId)
    const pieces = await schedulePieceRemoval(ctx, storage!, storage!.pieceCids.at(-1)!, 'V2 piece removal')
    await waitForRemoval(ctx, storage!.dataSetId, pieces - 1n)
    const [after, { expectedRate }] = await Promise.all([
      railStateV2(synapse, pay!, storage!.pdpRailId),
      expectedStorageRate(synapse, environment, storage!.dataSetId),
    ])
    assert.equal(after.incomingRate, expectedRate, 'V2 rail rate differs from size and price after a removal')
    assert(after.incomingRate < before.incomingRate, 'Removing a piece did not lower the v2 rate')
  })

  // Only FWSS may end a PDP rail, so its records and the rail cannot disagree.
  if (legacy) {
    await runner.run('legacy.pdp-rail.payer-cannot-bypass-fwss', ['legacy.state'], () =>
      assertV1PayerCannotTerminate(ctx, steady!)
    )
  }
  await runner.run('v2.pdp-rail.payer-cannot-bypass-fwss', ['v2.create.storage'], async () => {
    const key = v2Keys(ctx, storage!, await beneficiaryOf(ctx)).pdp
    try {
      await simulateContract(synapse.client, {
        account: synapse.client.account,
        address: pay!,
        abi: payV2Abi,
        functionName: 'terminateRail',
        args: [key.operator, key.from, key.recipient, key.nonce, tokenId(key.token)],
      })
    } catch (error) {
      console.log(`Payer termination of the v2 PDP rail refused: ${findRevertErrorName(error)}`)
      return
    }
    throw new Error('The payer can terminate its FWSS PDP rail on FilecoinPayV2 directly, without FWSS recording the end')
  })

  if (legacy && cdn != null) {
    await runner.run('legacy.cdn.terminate', ['legacy.state'], () =>
      terminateCdnService(synapse, environment, cdn, 'CDN termination of a legacy data set')
    )
  }
  await runner.run('v2.cdn.terminate', ['v2.create.cdn'], async () => {
    const receipt = await sendAsFilBeamController(
      synapse,
      environment,
      'terminateCDNService',
      [cdnV2!.dataSetId],
      'V2 CDN termination'
    )
    const events = parseEventLogs({ abi: fwssAbi, logs: receipt.logs, eventName: 'CDNServiceTerminated', strict: true })
    assert.equal(events.length, 1, 'V2 CDN termination must emit one CDNServiceTerminated')
    const [cdnRail, cacheMissRail, pdpRail] = await Promise.all(
      [cdnV2!.cdnRailId, cdnV2!.cacheMissRailId, cdnV2!.pdpRailId].map((id) => railStateV2(synapse, pay!, id))
    )
    assert.equal(cdnRail.settledUpTo, 0n, 'V2 CDN rail survived the CDN termination')
    assert.equal(cacheMissRail.settledUpTo, 0n, 'V2 cache-miss rail survived the CDN termination')
    assert(pdpRail.settledUpTo > 0n, 'V2 PDP rail ended with the CDN rails')
  })

  if (legacy && checkpoint.terminating != null) {
    await runner.run('legacy.terminate.payer', ['legacy.state'], async () => {
      await terminateAsPayer(synapse, environment, checkpoint.terminating!.dataSetId)
    })
  }
  await runner.run('v2.terminate.payer', ['v2.create.storage'], async () => {
    const { request } = await simulateContract(synapse.client, {
      account: synapse.client.account,
      address: checkpoint.fwss,
      abi: fwssPayAbi,
      functionName: 'terminateService',
      args: [storage!.dataSetId],
    })
    const receipt = await send(synapse, request, 'V2 payer service termination')
    const events = parseEventLogs({ abi: fwssPayAbi, logs: receipt.logs, eventName: 'ServiceTerminated', strict: true })
    assert.equal(events.length, 1, 'V2 termination must emit one ServiceTerminated')
    assert.equal(events[0].args.pdpRailId, storage!.pdpRailId, 'ServiceTerminated names another rail')
    const info = await fwssInfo(ctx, storage!.dataSetId)
    assert(info.pdpEndEpoch > 0n, 'FWSS recorded no end for the v2 data set')
    const head = await getBlockNumber(synapse.client)
    assert(info.pdpEndEpoch >= head - 1n, 'FWSS ended the v2 data set in the past')
  })

  if (legacy) {
    await runner.run('legacy.withdraw', ['legacy.state'], () => withdrawV1(ctx, 'Pay v1 withdrawal after the upgrade'))
  }
  await runner.run('v2.withdraw', ['v2.account.setup'], async () => {
    const amount = parseUnits('0.001', 18)
    const [walletBefore, balanceBefore] = await Promise.all([
      ERC20.balance(synapse.client, { address: checkpoint.client }),
      balanceV2(synapse, pay!, checkpoint.client, checkpoint.token),
    ])
    const { request } = await simulateContract(synapse.client, {
      account: synapse.client.account,
      address: pay!,
      abi: payV2Abi,
      functionName: 'withdraw',
      args: [checkpoint.token, amount],
    })
    await send(synapse, request, 'Pay v2 withdrawal')
    const [walletAfter, balanceAfter] = await Promise.all([
      ERC20.balance(synapse.client, { address: checkpoint.client }),
      balanceV2(synapse, pay!, checkpoint.client, checkpoint.token),
    ])
    assert.equal(walletAfter.value - walletBefore.value, amount, 'Wallet did not receive the v2 withdrawal')
    assert(balanceBefore - balanceAfter >= amount, 'V2 balance did not fund the withdrawal')
  })

  if (legacy) {
    await runner.run('legacy.no-new-v1-rails', ['legacy.state'], async () => {
      const head = await getBlockNumber(synapse.client)
      const created = await v1RailsCreatedSince(synapse, checkpoint.payV1, upgradeBlock + 1n, head)
      assert.equal(created.length, 0, `FilecoinPayV1 opened ${created.length} rails after the upgrade`)
      if (checkpoint.v1RailCount != null) {
        assert.equal(await v1RailCount(ctx), checkpoint.v1RailCount, 'The payer has new FilecoinPayV1 rails')
      }
    })
  }
}

async function main(): Promise<void> {
  const [phase, checkpointPath, filePath] = process.argv.slice(2)
  assert(phase && checkpointPath && filePath, 'Usage: fwss-pay-upgrade.ts <prepare|continue|v2> <checkpoint> <file>')
  process.argv.splice(2, 2)
  const environment = resolveEnvironment({ defaultUserIndex: 2, requireFiles: true })
  assert.equal(environment.network, 'devnet', 'The FWSS Pay scenario is devnet-only')
  const synapse = createSynapse(environment)
  assert.equal(await getChainId(synapse.client), 31_415_926, 'RPC endpoint is not the expected local devnet chain')
  const runner = new StepRunner(phase, parsePending(process.env.FWSS_PAY_PENDING), process.env.FWSS_PAY_RESULTS)
  const checkpoint: Checkpoint =
    phase === 'prepare' || phase === 'v2'
      ? {
          client: getAddress(synapse.client.account.address),
          fwss: getAddress(environment.chain.contracts.fwss.address),
          payV1: getAddress(contractsOf(environment).filecoinPay),
          token: getAddress(environment.chain.contracts.usdfc.address),
        }
      : loadCheckpoint(checkpointPath)
  const ctx: Context = { environment, synapse, runner, checkpoint, source: new Uint8Array(await readFile(filePath)) }

  if (phase === 'prepare') await prepare(ctx, checkpointPath)
  else if (phase === 'continue') await proceed(ctx, requiredBigInt('FWSS_UPGRADE_BLOCK'))
  else if (phase === 'v2') await proceed(ctx, undefined)
  else throw new Error(`Unknown phase ${phase}`)
  if (phase !== 'prepare') saveCheckpoint(checkpointPath, checkpoint)

  console.log(`=== ${phase}: ${runner.summary()} ===`)
  if (runner.failed()) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
