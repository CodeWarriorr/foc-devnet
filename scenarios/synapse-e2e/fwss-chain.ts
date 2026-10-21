import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as ERC20 from '@filoz/synapse-core/erc20'
import { deposit, getRail } from '@filoz/synapse-core/pay'
import { getDataSetLeafCount } from '@filoz/synapse-core/pdp-verifier'
import { getPdpDataSet, getPriceList } from '@filoz/synapse-core/warm-storage'
import {
  estimateContractGas,
  getBlockNumber,
  getLogs,
  getTransactionReceipt,
  readContract,
  simulateContract,
  writeContract,
} from 'viem/actions'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  parseUnits,
  toHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readAccountState, type ScenarioSynapse } from './account.ts'
import { freshMetadata, type ScenarioEnvironment } from './environment.ts'
import {
  assertReceiptSucceeded,
  calculateExpectedStorageRate,
  calculateSettlementAmounts,
  classifyProofPollError,
  findRevertErrorName,
} from './lifecycle-assertions.ts'
import { createFreshContext } from './storage.ts'

export const fwssAbi = parseAbi([
  'error OwnableUnauthorizedAccount(address account)',
  'function configureProvingPeriod(uint64 maxProvingPeriod, uint256 challengeWindowSize)',
  'error OnlyFilBeamControllerAllowed(address expected, address actual)',
  'error FilBeamServiceNotConfigured(uint256 dataSetId)',
  'function terminateService(uint256 dataSetId)',
  'function settleFilBeamPaymentRails(uint256 dataSetId, uint256 cdnAmount, uint256 cacheMissAmount)',
  'function terminateCDNService(uint256 dataSetId)',
  'event CDNServiceTerminated(address indexed caller, uint256 indexed dataSetId, uint256 cacheMissRailId, uint256 cdnRailId)',
  'event ServiceTerminated(address indexed approver, uint256 indexed dataSetId, uint256 pdpRailId, uint256 cacheMissRailId, uint256 cdnRailId)',
  'event PDPPaymentTerminated(uint256 indexed dataSetId, uint256 endEpoch, uint256 pdpRailId)',
])

export const stateViewAbi = parseAbi([
  'function getPDPConfig() view returns (uint64 maxProvingPeriod, uint256 challengeWindowSize, uint256 challengesPerProof, uint256 initChallengeWindowStart)',
  'function getDataSet(uint256 dataSetId) view returns ((uint256 pdpRailId, uint256 cacheMissRailId, uint256 cdnRailId, address payer, address payee, address serviceProvider, uint256 commissionBps, uint256 clientDataSetId, uint256 pdpEndEpoch, uint256 providerId, uint96 pendingOneTimePayments, uint96 lifecycleReserveBalance, uint256 dataSetId) info)',
  'function provenPeriods(uint256 dataSetId, uint256 periodId) view returns (bool)',
  'function provingActivationEpoch(uint256 dataSetId) view returns (uint256)',
  'function getDataSetSizeInBytes(uint256 leafCount) pure returns (uint256)',
  'function getDataSetMetadata(uint256 dataSetId, string key) view returns (bool exists, string value)',
])

export const pdpAbi = parseAbi([
  'error InvalidSignature(address expected, address actual)',
  'error ClientDataSetAlreadyRegistered(uint256 clientDataSetId)',
  'error DataSetPaymentAlreadyTerminated(uint256 dataSetId)',
  'function addPieces(uint256 setId, address listenerAddr, (bytes data)[] pieceData, bytes extraData) payable returns (uint256)',
  'function getDataSetLastProvenEpoch(uint256 setId) view returns (uint256)',
  'function getNextChallengeEpoch(uint256 setId) view returns (uint256)',
])

export const payAbi = parseAbi([
  'function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)',
  'function settleRail(uint256 railId, uint256 untilEpoch) returns (uint256 totalSettledAmount, uint256 totalNetPayeeAmount, uint256 totalOperatorCommission, uint256 totalNetworkFee, uint256 finalSettledEpoch, string note)',
  'event RailSettled(uint256 indexed railId, uint256 totalSettledAmount, uint256 totalNetPayeeAmount, uint256 operatorCommission, uint256 networkFee, uint256 settledUpTo)',
  'event RailTerminated(uint256 indexed railId, address indexed by, uint256 endEpoch)',
  'event RailRateModified(uint256 indexed railId, uint256 oldRate, uint256 newRate)',
])

export const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function proofTimeoutMilliseconds(): number {
  const value = Number(process.env.FWSS_PROOF_TIMEOUT_MS ?? 900_000)
  assert(Number.isSafeInteger(value) && value > 0, 'FWSS_PROOF_TIMEOUT_MS must be a positive integer')
  return value
}

export function contractsOf(environment: ScenarioEnvironment) {
  assert(environment.contracts != null, 'Devnet contract exports are required')
  return environment.contracts
}

// viem's waitForTransactionReceipt also fetches blocks by number, which Lotus
// rejects for null rounds. Poll the receipt directly and retry RPC errors.
export async function waitForReceipt(synapse: ScenarioSynapse, hash: Hash, label: string) {
  let lastError: unknown
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      return await getTransactionReceipt(synapse.client, { hash })
    } catch (error) {
      lastError = error
    }
    await delay(1_000)
  }
  const details = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`${label} transaction ${hash} was not confirmed${details}`)
}

export async function send(synapse: ScenarioSynapse, request: Parameters<typeof writeContract>[1], label: string) {
  // FEVM gas depends on state that can change before inclusion; a no-op settlement once ran out
  // of gas at exactly the estimate.
  const estimate = await estimateContractGas(synapse.client, request as Parameters<typeof estimateContractGas>[1])
  const gas = (estimate * 13n) / 10n
  const hash = (await writeContract(synapse.client, { ...request, gas })) as Hash
  console.log(`${label} submitted: ${hash}`)
  const receipt = await waitForReceipt(synapse, hash, label)
  assertReceiptSucceeded(receipt, label)
  return receipt
}

export type ProvingPeriod = {
  activationEpoch: bigint
  maxProvingPeriod: bigint
  /** Last epoch of the period; a proof for it must land by this epoch. */
  deadline: bigint
  proven: boolean
  lastProvenEpoch: bigint
}

/**
 * Waits until the chain head is past the deadline of `period` for a data set
 * and reports whether FWSS recorded that period as proven. Periods are counted
 * from the data set's proving activation, as FWSS does.
 */
export async function waitForPeriodEnd(
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  period: bigint
): Promise<ProvingPeriod> {
  const contracts = contractsOf(environment)
  const client = createPublicClient({ chain: environment.chain, transport: http(), ccipRead: false })
  const started = Date.now()
  let lastHead = 0n
  while (Date.now() - started < proofTimeoutMilliseconds()) {
    try {
      const [[maxProvingPeriod], activationEpoch, head] = await Promise.all([
        readContract(client, { address: contracts.fwssStateView, abi: stateViewAbi, functionName: 'getPDPConfig' }),
        readContract(client, {
          address: contracts.fwssStateView,
          abi: stateViewAbi,
          functionName: 'provingActivationEpoch',
          args: [dataSetId],
        }),
        getBlockNumber(client),
      ])
      lastHead = head
      const deadline = activationEpoch + (period + 1n) * maxProvingPeriod
      if (activationEpoch > 0n && head > deadline) {
        const [proven, lastProvenEpoch] = await Promise.all([
          readContract(client, {
            address: contracts.fwssStateView,
            abi: stateViewAbi,
            functionName: 'provenPeriods',
            args: [dataSetId, period],
          }),
          readContract(client, {
            address: contracts.pdpVerifier,
            abi: pdpAbi,
            functionName: 'getDataSetLastProvenEpoch',
            args: [dataSetId],
          }),
        ])
        console.log(
          `Period ended: dataSet=${dataSetId} period=${period} proven=${proven} lastProven=${lastProvenEpoch} deadline=${deadline} head=${head}`
        )
        return { activationEpoch, maxProvingPeriod, deadline, proven, lastProvenEpoch }
      }
    } catch (error) {
      const stateFork = classifyProofPollError(error)
      console.log(`Proof polling crossed unavailable state at fork epoch ${stateFork.epoch}; retrying`)
    }
    await delay(5_000)
  }
  throw new Error(`Timed out waiting for the end of period ${period} of data set ${dataSetId}; head=${lastHead}`)
}

/** Waits for the end of the proving period that holds the chain head. */
export async function waitForCurrentPeriodEnd(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint
): Promise<ProvingPeriod> {
  const contracts = contractsOf(environment)
  const [[maxProvingPeriod], activationEpoch, head] = await Promise.all([
    readContract(synapse.client, { address: contracts.fwssStateView, abi: stateViewAbi, functionName: 'getPDPConfig' }),
    readContract(synapse.client, {
      address: contracts.fwssStateView,
      abi: stateViewAbi,
      functionName: 'provingActivationEpoch',
      args: [dataSetId],
    }),
    getBlockNumber(synapse.client),
  ])
  assert(activationEpoch > 0n && head > activationEpoch, `Data set ${dataSetId} has not started proving`)
  return waitForPeriodEnd(environment, dataSetId, (head - activationEpoch - 1n) / maxProvingPeriod)
}

// Synapse deposits the exact shortfall, so the payer's funds equal its lockup. Rails from earlier
// scenarios then leave the CDN lockup a few wei short, and Filecoin Pay cannot settle the account
// forward, which stops rail settlement at the last settled epoch.
const FUNDING_HEADROOM = parseUnits('5', 18)

export async function depositHeadroom(synapse: ScenarioSynapse): Promise<void> {
  const approval = await ERC20.approve(synapse.client, { amount: FUNDING_HEADROOM })
  assertReceiptSucceeded(await waitForReceipt(synapse, approval, 'Headroom USDFC approval'), 'Headroom USDFC approval')
  const hash = await deposit(synapse.client, { amount: FUNDING_HEADROOM })
  assertReceiptSucceeded(await waitForReceipt(synapse, hash, 'Headroom deposit'), 'Headroom deposit')
}

/** A copy of `bytes` with its first byte changed, so each piece gets its own CID. */
export function variant(bytes: Uint8Array, tag: number): Uint8Array {
  const copy = Uint8Array.from(bytes)
  copy[0] ^= tag
  return copy
}

export async function dataSetRecord(synapse: ScenarioSynapse, environment: ScenarioEnvironment, dataSetId: bigint) {
  const dataSet = await getPdpDataSet(synapse.client, {
    dataSetId,
    contractAddress: contractsOf(environment).fwssStateView,
  })
  assert(dataSet != null, `Data set ${dataSetId} is not readable`)
  return dataSet
}

/** Creates a data set with fresh metadata on one provider and commits every piece to it. */
export async function createDataSet(
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

const railRateModifiedEvent = parseAbiItem('event RailRateModified(uint256 indexed railId, uint256 oldRate, uint256 newRate)')
// Lotus caps eth_getLogs at 2880 blocks.
const LOG_CHUNK = 2_000n

export type RateSegment = { from: bigint; to: bigint; rate: bigint }

/**
 * Gross that settling `railId` over (fromEpoch, toEpoch] must pay. Filecoin Pay keeps an old rate
 * through the block that changed it, and FWSS pays each rate segment for its epochs inside proven
 * periods, so the amount follows from the rail's rate changes and the data set's proven periods.
 */
export async function expectedProvenGross(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  railId: bigint,
  fromEpoch: bigint,
  toEpoch: bigint
): Promise<{ gross: bigint; segments: RateSegment[] }> {
  const contracts = contractsOf(environment)
  const head = await getBlockNumber(synapse.client)
  const changes = []
  for (let start = fromEpoch + 1n; start <= head; start += LOG_CHUNK) {
    const end = start + LOG_CHUNK - 1n < head ? start + LOG_CHUNK - 1n : head
    changes.push(
      ...(await getLogs(synapse.client, {
        address: contracts.filecoinPay,
        event: railRateModifiedEvent,
        args: { railId },
        fromBlock: start,
        toBlock: end,
      }))
    )
  }
  const [rail, [maxProvingPeriod], activationEpoch] = await Promise.all([
    getRail(synapse.client, { railId }),
    readContract(synapse.client, { address: contracts.fwssStateView, abi: stateViewAbi, functionName: 'getPDPConfig' }),
    readContract(synapse.client, {
      address: contracts.fwssStateView,
      abi: stateViewAbi,
      functionName: 'provingActivationEpoch',
      args: [dataSetId],
    }),
  ])
  const segments: RateSegment[] = []
  let start = fromEpoch
  for (const change of changes) {
    const block = change.blockNumber
    // Filecoin Pay queues the old rate once per block, so a later change in the same block adds nothing.
    if (block <= start) continue
    if (start < toEpoch) segments.push({ from: start, to: block < toEpoch ? block : toEpoch, rate: change.args.oldRate! })
    start = block
  }
  if (start < toEpoch) segments.push({ from: start, to: toEpoch, rate: rail.paymentRate })

  let gross = 0n
  for (const segment of segments) {
    let from = segment.from > activationEpoch ? segment.from : activationEpoch
    while (from < segment.to) {
      const period = (from - activationEpoch) / maxProvingPeriod
      const deadline = activationEpoch + (period + 1n) * maxProvingPeriod
      const to = deadline < segment.to ? deadline : segment.to
      const proven = await readContract(synapse.client, {
        address: contracts.fwssStateView,
        abi: stateViewAbi,
        functionName: 'provenPeriods',
        args: [dataSetId, period],
      })
      if (proven) gross += segment.rate * (to - from)
      from = to
    }
  }
  console.log(
    `Rail ${railId} over (${fromEpoch}, ${toEpoch}]: ${segments.map((s) => `(${s.from},${s.to}]@${s.rate}`).join(' ')} gross=${gross}`
  )
  return { gross, segments }
}

/** Simulates the provider adding `pieceCid` with `extraData` and requires FWSS to refuse it. */
export async function assertAddRejected(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  piece: { bytes: Uint8Array },
  extraData: Hex,
  expectedError: string,
  label: string
): Promise<void> {
  const { serviceProvider } = await dataSetRecord(synapse, environment, dataSetId)
  try {
    await simulateContract(synapse.client, {
      account: serviceProvider,
      address: contractsOf(environment).pdpVerifier,
      abi: pdpAbi,
      functionName: 'addPieces',
      args: [dataSetId, zeroAddress, [{ data: toHex(piece.bytes) }], extraData],
    })
  } catch (error) {
    assert.equal(findRevertErrorName(error), expectedError, `${label} was rejected for an unexpected reason`)
    return
  }
  throw new Error(`${label} was accepted`)
}

/** Terminates a data set as its payer and checks that FWSS and Filecoin Pay record the same end. */
export async function terminateAsPayer(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint
): Promise<bigint> {
  const contracts = contractsOf(environment)
  const before = await dataSetRecord(synapse, environment, dataSetId)
  const simulation = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: environment.chain.contracts.fwss.address,
    abi: fwssAbi,
    functionName: 'terminateService',
    args: [dataSetId],
  })
  const receipt = await send(synapse, simulation.request, 'Payer service termination')
  const terminatedEvents = parseEventLogs({ abi: fwssAbi, logs: receipt.logs, eventName: 'ServiceTerminated', strict: false })
  const paymentTerminatedEvents = parseEventLogs({
    abi: fwssAbi,
    logs: receipt.logs,
    eventName: 'PDPPaymentTerminated',
    strict: false,
  })
  assert.equal(terminatedEvents.length, 1, 'Termination receipt must contain one ServiceTerminated event')
  assert.equal(paymentTerminatedEvents.length, 1, 'Termination receipt must contain one PDPPaymentTerminated event')
  const terminated = terminatedEvents[0]
  const paymentTerminated = paymentTerminatedEvents[0]
  const approver = terminated.args.approver
  assert(approver != null, 'ServiceTerminated event has no approver')
  assert.equal(approver.toLowerCase(), synapse.client.account.address.toLowerCase())
  assert.equal(terminated.args.dataSetId, dataSetId)
  assert.equal(terminated.args.pdpRailId, before.pdpRailId)

  const railEvents = parseEventLogs({ abi: payAbi, logs: receipt.logs, eventName: 'RailTerminated', strict: false })
  assert.equal(railEvents.length, 1, 'Termination receipt must contain exactly one PDP RailTerminated event')
  const [rail, info] = await Promise.all([
    getRail(synapse.client, { railId: before.pdpRailId }),
    readContract(synapse.client, {
      address: contracts.fwssStateView,
      abi: stateViewAbi,
      functionName: 'getDataSet',
      args: [dataSetId],
    }),
  ])
  const endEpoch = paymentTerminated.args.endEpoch
  assert(endEpoch != null, 'PDPPaymentTerminated event has no end epoch')
  assert(endEpoch > 0n, 'Termination produced a zero end epoch')
  assert.equal(paymentTerminated.args.pdpRailId, before.pdpRailId)
  assert.equal(railEvents[0].args.railId, before.pdpRailId)
  const railTerminator = railEvents[0].args.by
  assert(railTerminator != null, 'RailTerminated event has no terminator')
  assert.equal(railTerminator.toLowerCase(), environment.chain.contracts.fwss.address.toLowerCase())
  assert.equal(railEvents[0].args.endEpoch, endEpoch)
  assert.equal(rail.endEpoch, endEpoch, 'Filecoin Pay rail end differs from termination event')
  assert.equal(info.pdpEndEpoch, endEpoch, 'FWSS data set end differs from Filecoin Pay rail end')
  console.log(`Payer termination verified: dataSet=${dataSetId} rail=${before.pdpRailId} endEpoch=${endEpoch}`)
  return endEpoch
}

// ── FilBeam CDN rails ────────────────────────────────────────

export type CdnRails = { dataSetId: bigint; cdnRailId: bigint; cacheMissRailId: bigint }

/** The FOC deployer, which foc-devnet makes the FilBeam controller. */
function filBeamController(environment: ScenarioEnvironment) {
  const path = process.env.DEVNET_INFO_PATH
  assert(path, 'DEVNET_INFO_PATH is required')
  const key = JSON.parse(readFileSync(path, 'utf8')).info.foc_deployer?.private_key_hex
  assert(typeof key === 'string', 'devnet-info.json exports no foc_deployer key')
  const account = privateKeyToAccount(key as Hex)
  return createWalletClient({ account, chain: environment.chain, transport: http() })
}

/** Settles both CDN rails as the FilBeam controller and checks every balance and lockup change. */
export async function settleCdnExactly(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  cdn: CdnRails,
  cdnAmount: bigint,
  cacheMissAmount: bigint,
  label: string
): Promise<void> {
  const wallet = filBeamController(environment)
  const railIds = [cdn.cdnRailId, cdn.cacheMissRailId]
  const rails = await Promise.all(railIds.map((railId) => getRail(synapse.client, { railId })))
  const [payerBefore, cdnPayeeBefore, cacheMissPayeeBefore] = await Promise.all([
    readAccountState(synapse),
    payeeFunds(synapse, environment, rails[0].token, rails[0].to),
    payeeFunds(synapse, environment, rails[1].token, rails[1].to),
  ])
  const { request } = await simulateContract(wallet, {
    address: environment.chain.contracts.fwss.address,
    abi: fwssAbi,
    functionName: 'settleFilBeamPaymentRails',
    args: [cdn.dataSetId, cdnAmount, cacheMissAmount],
  })
  const hash = await wallet.writeContract(request)
  assertReceiptSucceeded(await waitForReceipt(synapse, hash, label), label)
  const railsAfter = await Promise.all(railIds.map((railId) => getRail(synapse.client, { railId })))
  const [payerAfter, cdnPayeeAfter, cacheMissPayeeAfter] = await Promise.all([
    readAccountState(synapse),
    payeeFunds(synapse, environment, rails[0].token, rails[0].to),
    payeeFunds(synapse, environment, rails[1].token, rails[1].to),
  ])
  assert.equal(payerBefore.funds - payerAfter.funds, cdnAmount + cacheMissAmount, `${label}: payer debit differs`)
  assert.equal(rails[0].lockupFixed - railsAfter[0].lockupFixed, cdnAmount, `${label}: CDN lockup not reduced by its payment`)
  assert.equal(
    rails[1].lockupFixed - railsAfter[1].lockupFixed,
    cacheMissAmount,
    `${label}: cache-miss lockup not reduced by its payment`
  )
  const cdnNet = calculateSettlementAmounts(cdnAmount, rails[0].commissionRateBps).netPayee
  const cacheMissNet = calculateSettlementAmounts(cacheMissAmount, rails[1].commissionRateBps).netPayee
  if (rails[0].to === rails[1].to) {
    assert.equal(cdnPayeeAfter - cdnPayeeBefore, cdnNet + cacheMissNet, `${label}: CDN payee credit differs`)
  } else {
    assert.equal(cdnPayeeAfter - cdnPayeeBefore, cdnNet, `${label}: CDN payee credit differs`)
    assert.equal(cacheMissPayeeAfter - cacheMissPayeeBefore, cacheMissNet, `${label}: cache-miss payee credit differs`)
  }
  console.log(`${label}: dataSet=${cdn.dataSetId} cdn=${cdnAmount} cacheMiss=${cacheMissAmount} tx=${hash}`)
}

/**
 * Ends the CDN service as the FilBeam controller: both CDN rails terminate, the withCDN metadata
 * goes, the PDP rail is untouched, and a second termination is refused.
 */
export async function terminateCdnService(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  cdn: CdnRails & { pdpRailId: bigint },
  label: string
): Promise<void> {
  const contracts = contractsOf(environment)
  const fwss = environment.chain.contracts.fwss.address
  const wallet = filBeamController(environment)
  const { request } = await simulateContract(wallet, {
    address: fwss,
    abi: fwssAbi,
    functionName: 'terminateCDNService',
    args: [cdn.dataSetId],
  })
  const hash = await wallet.writeContract(request)
  const receipt = await waitForReceipt(synapse, hash, label)
  assertReceiptSucceeded(receipt, label)
  const events = parseEventLogs({ abi: fwssAbi, logs: receipt.logs, eventName: 'CDNServiceTerminated', strict: true })
  assert.equal(events.length, 1, `${label}: receipt must contain one CDNServiceTerminated event`)
  assert.deepEqual(
    [events[0].args.dataSetId, events[0].args.cacheMissRailId, events[0].args.cdnRailId],
    [cdn.dataSetId, cdn.cacheMissRailId, cdn.cdnRailId],
    `${label}: CDNServiceTerminated names other rails`
  )
  const [cdnRail, cacheMissRail, pdpRail, [hasCdn]] = await Promise.all([
    getRail(synapse.client, { railId: cdn.cdnRailId }),
    getRail(synapse.client, { railId: cdn.cacheMissRailId }),
    getRail(synapse.client, { railId: cdn.pdpRailId }),
    readContract(synapse.client, {
      address: contracts.fwssStateView,
      abi: stateViewAbi,
      functionName: 'getDataSetMetadata',
      args: [cdn.dataSetId, 'withCDN'],
    }),
  ])
  assert(cdnRail.endEpoch > 0n && cacheMissRail.endEpoch > 0n, `${label}: CDN rails were not terminated`)
  assert.equal(pdpRail.endEpoch, 0n, `${label}: the PDP rail was terminated with the CDN rails`)
  assert.equal(hasCdn, false, `${label}: withCDN metadata survived the termination`)
  try {
    await simulateContract(wallet, { address: fwss, abi: fwssAbi, functionName: 'terminateCDNService', args: [cdn.dataSetId] })
    throw new Error(`${label}: a second CDN termination was accepted`)
  } catch (error) {
    assert.equal(findRevertErrorName(error), 'FilBeamServiceNotConfigured', `${label}: second termination failed for another reason`)
  }
  console.log(`${label}: dataSet=${cdn.dataSetId} cdnEnd=${cdnRail.endEpoch} cacheMissEnd=${cacheMissRail.endEpoch} tx=${hash}`)
}

/**
 * Polls until the provider has scheduled the next challenge. PDPVerifier 3.5.0 removes pieces in
 * processPieceDeletions, which clears the challenge; FWSS reprices the rail in the nextProvingPeriod
 * callback that follows.
 */
export async function waitForNextChallenge(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint
): Promise<void> {
  const started = Date.now()
  const timeout = Number(process.env.FWSS_PROOF_TIMEOUT_MS ?? 900_000)
  const read = () =>
    readContract(synapse.client, {
      address: contractsOf(environment).pdpVerifier,
      abi: pdpAbi,
      functionName: 'getNextChallengeEpoch',
      args: [dataSetId],
    })
  while ((await read()) === 0n) {
    assert(Date.now() - started < timeout, `Data set ${dataSetId} has no challenge scheduled after piece removal`)
    await delay(5_000)
  }
}

/** The PDP rail rate a data set's current size and the published price list require. */
export async function expectedStorageRate(synapse: ScenarioSynapse, environment: ScenarioEnvironment, dataSetId: bigint) {
  const contracts = contractsOf(environment)
  const [leafCount, priceList] = await Promise.all([
    getDataSetLeafCount(synapse.client, { dataSetId, contractAddress: contracts.pdpVerifier }),
    getPriceList(synapse.client, { contractAddress: contracts.fwssStateView }),
  ])
  const totalBytes = await readContract(synapse.client, {
    address: contracts.fwssStateView,
    abi: stateViewAbi,
    functionName: 'getDataSetSizeInBytes',
    args: [leafCount],
  })
  const expectedRate = calculateExpectedStorageRate(
    totalBytes,
    priceList.rates.storagePerTibPerMonth,
    priceList.rates.datasetFeePerMonth
  )
  return { expectedRate, totalBytes, token: priceList.token }
}

async function payeeFunds(synapse: ScenarioSynapse, environment: ScenarioEnvironment, token: Address, payee: Address) {
  const [funds] = await readContract(synapse.client, {
    address: contractsOf(environment).filecoinPay,
    abi: payAbi,
    functionName: 'accounts',
    args: [token, payee],
  })
  return funds
}

/**
 * Settles a rail up to `targetEpoch`, requires the exact gross amount the caller
 * derived independently, checks the payer and payee balance changes, and checks
 * that settling the same range again pays nothing.
 */
export async function settleExactly(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  railId: bigint,
  targetEpoch: bigint,
  expectedGross: bigint,
  label: string
): Promise<void> {
  const contracts = contractsOf(environment)
  const railBefore = await getRail(synapse.client, { railId })
  const expected = calculateSettlementAmounts(expectedGross, railBefore.commissionRateBps)
  const [payerBefore, payeeBefore] = await Promise.all([
    readAccountState(synapse),
    payeeFunds(synapse, environment, railBefore.token, railBefore.to),
  ])
  const simulation = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: contracts.filecoinPay,
    abi: payAbi,
    functionName: 'settleRail',
    args: [railId, targetEpoch],
  })
  assert.deepEqual(
    simulation.result.slice(0, 5),
    [expected.gross, expected.netPayee, expected.operatorCommission, expected.networkFee, targetEpoch],
    `${label} simulation differs from independent epoch, rate, and fee calculation`
  )
  const receipt = await send(synapse, simulation.request, label)
  const events = parseEventLogs({ abi: payAbi, logs: receipt.logs, eventName: 'RailSettled', strict: true })
  assert.equal(events.length, 1, `${label} receipt must contain exactly one RailSettled event`)
  const event = events[0].args
  assert.deepEqual(
    [event.railId, event.totalSettledAmount, event.totalNetPayeeAmount, event.operatorCommission, event.networkFee, event.settledUpTo],
    [railId, expected.gross, expected.netPayee, expected.operatorCommission, expected.networkFee, targetEpoch],
    `${label} RailSettled event differs from exact expected settlement`
  )
  const [railAfter, payerAfter, payeeAfter] = await Promise.all([
    getRail(synapse.client, { railId }),
    readAccountState(synapse),
    payeeFunds(synapse, environment, railBefore.token, railBefore.to),
  ])
  assert.equal(railAfter.settledUpTo, targetEpoch, `${label} rail cursor differs from settlement target`)
  assert.equal(payerBefore.funds - payerAfter.funds, expected.gross, `${label} payer debit differs from gross settlement`)
  assert.equal(payeeAfter - payeeBefore, expected.netPayee, `${label} payee credit differs from net settlement`)

  const repeat = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: contracts.filecoinPay,
    abi: payAbi,
    functionName: 'settleRail',
    args: [railId, targetEpoch],
  })
  assert.deepEqual(repeat.result.slice(0, 5), [0n, 0n, 0n, 0n, targetEpoch], `Repeated ${label} is not a zero-payment operation`)
  const repeatReceipt = await send(synapse, repeat.request, `Repeated ${label}`)
  assert.equal(
    parseEventLogs({ abi: payAbi, logs: repeatReceipt.logs, eventName: 'RailSettled', strict: false }).length,
    0,
    `Repeated ${label} unexpectedly emitted RailSettled`
  )
  const [railRepeated, payerRepeated, payeeRepeated] = await Promise.all([
    getRail(synapse.client, { railId }),
    readAccountState(synapse),
    payeeFunds(synapse, environment, railBefore.token, railBefore.to),
  ])
  assert.equal(railRepeated.settledUpTo, railAfter.settledUpTo, `Repeated ${label} moved the rail cursor`)
  assert.equal(payerRepeated.funds, payerAfter.funds, `Repeated ${label} debited the payer`)
  assert.equal(payeeRepeated, payeeAfter, `Repeated ${label} credited the payee`)
  console.log(`Exact settlement verified (${label}): rail=${railId} until=${targetEpoch} gross=${expected.gross} net=${expected.netPayee}`)
}
