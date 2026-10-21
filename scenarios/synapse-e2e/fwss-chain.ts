import assert from 'node:assert/strict'
import { getRail } from '@filoz/synapse-core/pay'
import { getDataSetLeafCount } from '@filoz/synapse-core/pdp-verifier'
import { getPriceList } from '@filoz/synapse-core/warm-storage'
import {
  estimateContractGas,
  getBlockNumber,
  getTransactionReceipt,
  readContract,
  simulateContract,
  writeContract,
} from 'viem/actions'
import { createPublicClient, http, parseAbi, parseEventLogs, type Address, type Hash } from 'viem'
import { readAccountState, type ScenarioSynapse } from './account.ts'
import type { ScenarioEnvironment } from './environment.ts'
import {
  assertReceiptSucceeded,
  calculateExpectedStorageRate,
  calculateSettlementAmounts,
  classifyProofPollError,
} from './lifecycle-assertions.ts'

export const fwssAbi = parseAbi([
  'error OwnableUnauthorizedAccount(address account)',
  'function configureProvingPeriod(uint64 maxProvingPeriod, uint256 challengeWindowSize)',
  'function terminateService(uint256 dataSetId)',
  'event ServiceTerminated(address indexed approver, uint256 indexed dataSetId, uint256 pdpRailId, uint256 cacheMissRailId, uint256 cdnRailId)',
  'event PDPPaymentTerminated(uint256 indexed dataSetId, uint256 endEpoch, uint256 pdpRailId)',
])

export const stateViewAbi = parseAbi([
  'function getPDPConfig() view returns (uint64 maxProvingPeriod, uint256 challengeWindowSize, uint256 challengesPerProof, uint256 initChallengeWindowStart)',
  'function getDataSet(uint256 dataSetId) view returns ((uint256 pdpRailId, uint256 cacheMissRailId, uint256 cdnRailId, address payer, address payee, address serviceProvider, uint256 commissionBps, uint256 clientDataSetId, uint256 pdpEndEpoch, uint256 providerId, uint96 pendingOneTimePayments, uint96 lifecycleReserveBalance, uint256 dataSetId) info)',
  'function provenPeriods(uint256 dataSetId, uint256 periodId) view returns (bool)',
  'function provingActivationEpoch(uint256 dataSetId) view returns (uint256)',
  'function getDataSetSizeInBytes(uint256 leafCount) pure returns (uint256)',
])

export const pdpAbi = parseAbi([
  'error InvalidSignature(address expected, address actual)',
  'error ClientDataSetAlreadyRegistered(uint256 clientDataSetId)',
  'function addPieces(uint256 setId, address listenerAddr, (bytes data)[] pieceData, bytes extraData) payable returns (uint256)',
  'function getDataSetLastProvenEpoch(uint256 setId) view returns (uint256)',
  'function getNextChallengeEpoch(uint256 setId) view returns (uint256)',
])

export const payAbi = parseAbi([
  'function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)',
  'function settleRail(uint256 railId, uint256 untilEpoch) returns (uint256 totalSettledAmount, uint256 totalNetPayeeAmount, uint256 totalOperatorCommission, uint256 totalNetworkFee, uint256 finalSettledEpoch, string note)',
  'event RailSettled(uint256 indexed railId, uint256 totalSettledAmount, uint256 totalNetPayeeAmount, uint256 operatorCommission, uint256 networkFee, uint256 settledUpTo)',
  'event RailTerminated(uint256 indexed railId, address indexed by, uint256 endEpoch)',
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
