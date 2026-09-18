import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getRail } from '@filoz/synapse-core/pay'
import { getActivePieceCount, getDataSetLeafCount } from '@filoz/synapse-core/pdp-verifier'
import { getPdpDataSet, getPriceList } from '@filoz/synapse-core/warm-storage'
import {
  getBlockNumber,
  getChainId,
  readContract,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
} from 'viem/actions'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  parseAbi,
  parseEventLogs,
  toHex,
  zeroAddress,
  type Hash,
  type Hex,
} from 'viem'
import { createSynapse, prepareAccount, readAccountState, type ScenarioSynapse } from './account.ts'
import { freshMetadata, resolveEnvironment, type ScenarioEnvironment } from './environment.ts'
import {
  assertReceiptSucceeded,
  calculateExpectedStorageRate,
  calculateSettlementAmounts,
  findRevertErrorName,
} from './lifecycle-assertions.ts'
import { assertOnchainState } from './onchain.ts'
import {
  assertCompleteReplication,
  assertDirectRetrievals,
  assertDownloadedBytes,
  fileSize,
  uploadFile,
} from './storage.ts'

const fwssAbi = parseAbi([
  'error OwnableUnauthorizedAccount(address account)',
  'function configureProvingPeriod(uint64 maxProvingPeriod, uint256 challengeWindowSize)',
  'function terminateService(uint256 dataSetId)',
  'event ServiceTerminated(address indexed approver, uint256 indexed dataSetId, uint256 pdpRailId, uint256 cacheMissRailId, uint256 cdnRailId)',
  'event PDPPaymentTerminated(uint256 indexed dataSetId, uint256 endEpoch, uint256 pdpRailId)',
])

const stateViewAbi = parseAbi([
  'function getPDPConfig() view returns (uint64 maxProvingPeriod, uint256 challengeWindowSize, uint256 challengesPerProof, uint256 initChallengeWindowStart)',
  'function getDataSet(uint256 dataSetId) view returns ((uint256 pdpRailId, uint256 cacheMissRailId, uint256 cdnRailId, address payer, address payee, address serviceProvider, uint256 commissionBps, uint256 clientDataSetId, uint256 pdpEndEpoch, uint256 providerId, uint96 pendingOneTimePayments, uint96 lifecycleReserveBalance, uint256 dataSetId) info)',
  'function provenPeriods(uint256 dataSetId, uint256 periodId) view returns (bool)',
  'function provingActivationEpoch(uint256 dataSetId) view returns (uint256)',
  'function getDataSetSizeInBytes(uint256 leafCount) pure returns (uint256)',
])

const pdpAbi = parseAbi([
  'error InvalidSignature(address expected, address actual)',
  'error ClientDataSetAlreadyRegistered(uint256 clientDataSetId)',
  'function addPieces(uint256 setId, address listenerAddr, (bytes data)[] pieceData, bytes extraData) payable returns (uint256)',
  'function getDataSetLastProvenEpoch(uint256 setId) view returns (uint256)',
])

const addPiecesExtraDataParameters = [
  { type: 'uint256' },
  { type: 'string[][]' },
  { type: 'string[][]' },
  { type: 'bytes' },
] as const

const payAbi = parseAbi([
  'function accounts(address token, address owner) view returns (uint256 funds, uint256 lockupCurrent, uint256 lockupRate, uint256 lockupLastSettledAt)',
  'function settleRail(uint256 railId, uint256 untilEpoch) returns (uint256 totalSettledAmount, uint256 totalNetPayeeAmount, uint256 totalOperatorCommission, uint256 totalNetworkFee, uint256 finalSettledEpoch, string note)',
  'event RailSettled(uint256 indexed railId, uint256 totalSettledAmount, uint256 totalNetPayeeAmount, uint256 operatorCommission, uint256 networkFee, uint256 settledUpTo)',
  'event RailTerminated(uint256 indexed railId, address indexed by, uint256 endEpoch)',
])

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function proofTimeoutMilliseconds(): number {
  const value = Number(process.env.FWSS_PROOF_TIMEOUT_MS ?? 900_000)
  assert(Number.isSafeInteger(value) && value > 0, 'FWSS_PROOF_TIMEOUT_MS must be a positive integer')
  return value
}

async function send(
  synapse: ScenarioSynapse,
  request: Parameters<typeof writeContract>[1],
  label: string
) {
  const hash = (await writeContract(synapse.client, request)) as Hash
  console.log(`${label} submitted: ${hash}`)
  const receipt = await waitForTransactionReceipt(synapse.client, {
    hash,
    pollingInterval: 1_000,
    timeout: 120_000,
  })
  assertReceiptSucceeded(receipt, label)
  return receipt
}

async function assertUnauthorizedAdmin(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment
): Promise<void> {
  assert(environment.contracts != null, 'Devnet contract exports are required')
  const config = await readContract(synapse.client, {
    address: environment.contracts.fwssStateView,
    abi: stateViewAbi,
    functionName: 'getPDPConfig',
  })
  try {
    await simulateContract(synapse.client, {
      account: synapse.client.account,
      address: environment.chain.contracts.fwss.address,
      abi: fwssAbi,
      functionName: 'configureProvingPeriod',
      args: [config[0], config[1]],
    })
  } catch (error) {
    assert.equal(
      findRevertErrorName(error),
      'OwnableUnauthorizedAccount',
      'Unauthorized proving-period configuration reverted for an unexpected reason'
    )
    console.log('Unauthorized admin call rejected with OwnableUnauthorizedAccount')
    return
  }
  throw new Error('Unauthorized proving-period configuration unexpectedly succeeded')
}

function tamperAddPiecesSignature(extraData: Hex): Hex {
  const [nonce, metadataKeys, metadataValues, signature] = decodeAbiParameters(
    addPiecesExtraDataParameters,
    extraData
  )
  assert(signature.length >= 4, 'AddPieces signature is empty')
  const firstByte = Number.parseInt(signature.slice(2, 4), 16) ^ 1
  const tamperedSignature = `0x${firstByte.toString(16).padStart(2, '0')}${signature.slice(4)}` as Hex
  return encodeAbiParameters(addPiecesExtraDataParameters, [
    nonce,
    metadataKeys,
    metadataValues,
    tamperedSignature,
  ])
}

async function assertAddPiecesRejected(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  serviceProvider: `0x${string}`,
  pieceCid: { bytes: Uint8Array },
  extraData: Hex,
  expectedError: 'InvalidSignature' | 'ClientDataSetAlreadyRegistered'
): Promise<void> {
  assert(environment.contracts != null, 'Devnet contract exports are required')
  const before = await getActivePieceCount(synapse.client, {
    dataSetId,
    contractAddress: environment.contracts.pdpVerifier,
  })
  try {
    await simulateContract(synapse.client, {
      account: serviceProvider,
      address: environment.contracts.pdpVerifier,
      abi: pdpAbi,
      functionName: 'addPieces',
      args: [dataSetId, zeroAddress, [{ data: toHex(pieceCid.bytes) }], extraData],
    })
  } catch (error) {
    assert.equal(
      findRevertErrorName(error),
      expectedError,
      `AddPieces rejection differed from ${expectedError}`
    )
    const after = await getActivePieceCount(synapse.client, {
      dataSetId,
      contractAddress: environment.contracts.pdpVerifier,
    })
    assert.equal(after, before, `${expectedError} simulation changed active piece count`)
    console.log(`AddPieces rejected with ${expectedError}; active piece count remained ${after}`)
    return
  }
  throw new Error(`AddPieces unexpectedly accepted ${expectedError} test input`)
}

async function addSecondPieceAndValidateSignatures(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  sourcePath: string
): Promise<void> {
  assert(environment.contracts != null, 'Devnet contract exports are required')
  const dataSet = await getPdpDataSet(synapse.client, {
    dataSetId,
    contractAddress: environment.contracts.fwssStateView,
  })
  assert(dataSet != null, `Data set ${dataSetId} disappeared before second-piece upload`)
  const context = await synapse.storage.createContext({ dataSetId })
  assert.equal(context.dataSetId, dataSetId, 'Existing-data-set context resolved a different data set')
  assert.equal(context.provider.id, dataSet.providerId, 'Existing-data-set context resolved a different provider')

  const secondBytes = new Uint8Array(await readFile(sourcePath))
  assert(secondBytes.length > 0, 'Second piece source is empty')
  secondBytes[0] ^= 0xff
  const size = BigInt(secondBytes.byteLength)
  const preparationOptions = {
    context,
    dataSize: size,
    pieceSizes: [size],
  }
  const preparation = await synapse.storage.prepare(preparationOptions)
  if (preparation.transaction != null) {
    const funding = await preparation.transaction.execute({
      onHash: (hash) => console.log(`Second-piece funding submitted: ${hash}`),
    })
    console.log(`Second-piece funding confirmed: ${funding.hash}`)
  }

  const activeBefore = await getActivePieceCount(synapse.client, {
    dataSetId,
    contractAddress: environment.contracts.pdpVerifier,
  })
  assert.equal(activeBefore, 1n, 'Fresh uploaded data set must contain exactly one active piece')
  const stored = await context.store(secondBytes)
  const pieces = [{ pieceCid: stored.pieceCid }]
  const extraData = await context.presignForCommit(pieces)

  await assertAddPiecesRejected(
    synapse,
    environment,
    dataSetId,
    dataSet.serviceProvider,
    stored.pieceCid,
    tamperAddPiecesSignature(extraData),
    'InvalidSignature'
  )

  const committed = await context.commit({
    pieces,
    extraData,
    onSubmitted: (hash) => console.log(`Second-piece commit submitted: ${hash}`),
  })
  assert.equal(committed.dataSetId, dataSetId, 'Second piece committed to a different data set')
  assert.equal(committed.isNewDataSet, false, 'Second piece unexpectedly created a new data set')
  assert.equal(committed.pieceIds.length, 1, 'Second-piece commit did not confirm exactly one piece')
  const activeAfter = await getActivePieceCount(synapse.client, {
    dataSetId,
    contractAddress: environment.contracts.pdpVerifier,
  })
  assert.equal(activeAfter, activeBefore + 1n, 'Second-piece commit did not increment active piece count')

  await assertAddPiecesRejected(
    synapse,
    environment,
    dataSetId,
    dataSet.serviceProvider,
    stored.pieceCid,
    extraData,
    'ClientDataSetAlreadyRegistered'
  )
  const downloaded = await synapse.storage.download({ pieceCid: stored.pieceCid })
  assert(Buffer.from(downloaded).equals(secondBytes), 'Downloaded second piece differs from uploaded bytes')
  console.log(`Second piece verified in existing data set ${dataSetId}; active pieces=${activeAfter}`)
}

type CompletedProof = {
  activationEpoch: bigint
  deadline: bigint
}

async function waitForCompletedProof(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  initialLastProvenEpoch: bigint
): Promise<CompletedProof> {
  assert(environment.contracts != null, 'Devnet contract exports are required')
  const [maxProvingPeriod] = await readContract(synapse.client, {
    address: environment.contracts.fwssStateView,
    abi: stateViewAbi,
    functionName: 'getPDPConfig',
  })
  const started = Date.now()
  let observedLastProven = initialLastProvenEpoch
  let observedFirstPeriod = false
  while (Date.now() - started < proofTimeoutMilliseconds()) {
    const [lastProvenEpoch, activationEpoch, firstPeriodProven, blockNumber] = await Promise.all([
      readContract(synapse.client, {
        address: environment.contracts.pdpVerifier,
        abi: pdpAbi,
        functionName: 'getDataSetLastProvenEpoch',
        args: [dataSetId],
      }),
      readContract(synapse.client, {
        address: environment.contracts.fwssStateView,
        abi: stateViewAbi,
        functionName: 'provingActivationEpoch',
        args: [dataSetId],
      }),
      readContract(synapse.client, {
        address: environment.contracts.fwssStateView,
        abi: stateViewAbi,
        functionName: 'provenPeriods',
        args: [dataSetId, 0n],
      }),
      getBlockNumber(synapse.client),
    ])
    observedLastProven = lastProvenEpoch
    observedFirstPeriod = firstPeriodProven
    const deadline = activationEpoch + maxProvingPeriod
    if (
      activationEpoch > 0n &&
      lastProvenEpoch > initialLastProvenEpoch &&
      firstPeriodProven &&
      blockNumber >= deadline
    ) {
      console.log(
        `Completed proof observed: dataSet=${dataSetId} period=0 lastProven=${lastProvenEpoch} deadline=${deadline} head=${blockNumber}`
      )
      return { activationEpoch, deadline }
    }
    await delay(5_000)
  }
  throw new Error(
    `Timed out waiting for proven first period for data set ${dataSetId}; last proven epoch advanced from ${initialLastProvenEpoch} to ${observedLastProven}; period0=${observedFirstPeriod}`
  )
}

async function settleCompletedPeriod(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  activationEpoch: bigint,
  targetEpoch: bigint
): Promise<void> {
  assert(environment.contracts != null, 'Devnet contract exports are required')
  const dataSet = await getPdpDataSet(synapse.client, {
    dataSetId,
    contractAddress: environment.contracts.fwssStateView,
  })
  assert(dataSet != null, `Data set ${dataSetId} disappeared before settlement`)
  const railBefore = await getRail(synapse.client, { railId: dataSet.pdpRailId })
  const [leafCount, priceList] = await Promise.all([
    getDataSetLeafCount(synapse.client, {
      dataSetId,
      contractAddress: environment.contracts.pdpVerifier,
    }),
    getPriceList(synapse.client, { contractAddress: environment.contracts.fwssStateView }),
  ])
  const totalBytes = await readContract(synapse.client, {
    address: environment.contracts.fwssStateView,
    abi: stateViewAbi,
    functionName: 'getDataSetSizeInBytes',
    args: [leafCount],
  })
  const expectedRate = calculateExpectedStorageRate(
    totalBytes,
    priceList.rates.storagePerTibPerMonth,
    priceList.rates.datasetFeePerMonth
  )
  assert.equal(railBefore.token.toLowerCase(), priceList.token.toLowerCase(), 'PDP rail uses the wrong payment token')
  assert.equal(railBefore.paymentRate, expectedRate, 'PDP rail rate differs from data set size and price list')
  assert(expectedRate > 0n, 'PDP rail payment rate must be positive')
  assert.equal(railBefore.endEpoch, 0n, 'PDP rail terminated before controlled settlement')
  assert(
    railBefore.settledUpTo <= activationEpoch,
    `PDP rail was already settled beyond first-period activation ${activationEpoch}`
  )
  assert(targetEpoch > activationEpoch, 'First proving-period deadline must follow activation')
  const expected = calculateSettlementAmounts(
    expectedRate * (targetEpoch - activationEpoch),
    railBefore.commissionRateBps
  )
  assert(expected.gross > 0n, 'Controlled settlement must transfer a non-zero exact amount')

  const [payerBefore, payeeBefore] = await Promise.all([
    readAccountState(synapse),
    readContract(synapse.client, {
      address: environment.contracts.filecoinPay,
      abi: payAbi,
      functionName: 'accounts',
      args: [railBefore.token, railBefore.to],
    }),
  ])
  const simulation = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: environment.contracts.filecoinPay,
    abi: payAbi,
    functionName: 'settleRail',
    args: [dataSet.pdpRailId, targetEpoch],
  })
  assert.deepEqual(
    simulation.result.slice(0, 5),
    [expected.gross, expected.netPayee, expected.operatorCommission, expected.networkFee, targetEpoch],
    'Settlement simulation differs from independent epoch, rate, and fee calculation'
  )
  const receipt = await send(synapse, simulation.request, 'PDP rail settlement')
  const events = parseEventLogs({ abi: payAbi, logs: receipt.logs, eventName: 'RailSettled', strict: true })
  assert.equal(events.length, 1, 'Settlement receipt must contain exactly one RailSettled event')
  const event = events[0].args
  assert.deepEqual(
    [
      event.railId,
      event.totalSettledAmount,
      event.totalNetPayeeAmount,
      event.operatorCommission,
      event.networkFee,
      event.settledUpTo,
    ],
    [
      dataSet.pdpRailId,
      expected.gross,
      expected.netPayee,
      expected.operatorCommission,
      expected.networkFee,
      targetEpoch,
    ],
    'RailSettled event differs from exact expected settlement'
  )
  const [railAfter, payerAfter, payeeAfter] = await Promise.all([
    getRail(synapse.client, { railId: dataSet.pdpRailId }),
    readAccountState(synapse),
    readContract(synapse.client, {
      address: environment.contracts.filecoinPay,
      abi: payAbi,
      functionName: 'accounts',
      args: [railBefore.token, railBefore.to],
    }),
  ])
  assert.equal(railAfter.settledUpTo, targetEpoch, 'Rail cursor differs from settlement target')
  assert.equal(payerBefore.funds - payerAfter.funds, expected.gross, 'Payer debit differs from gross settlement')
  assert.equal(payeeAfter[0] - payeeBefore[0], expected.netPayee, 'Payee credit differs from net settlement')

  const repeat = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: environment.contracts.filecoinPay,
    abi: payAbi,
    functionName: 'settleRail',
    args: [dataSet.pdpRailId, targetEpoch],
  })
  assert.deepEqual(repeat.result.slice(0, 5), [0n, 0n, 0n, 0n, targetEpoch], 'Repeated settlement is not a zero-payment operation')
  const repeatReceipt = await send(synapse, repeat.request, 'Repeated PDP rail settlement')
  assert.equal(
    parseEventLogs({ abi: payAbi, logs: repeatReceipt.logs, eventName: 'RailSettled', strict: false }).length,
    0,
    'Repeated no-op settlement unexpectedly emitted RailSettled'
  )
  const [railRepeated, payerRepeated, payeeRepeated] = await Promise.all([
    getRail(synapse.client, { railId: dataSet.pdpRailId }),
    readAccountState(synapse),
    readContract(synapse.client, {
      address: environment.contracts.filecoinPay,
      abi: payAbi,
      functionName: 'accounts',
      args: [railBefore.token, railBefore.to],
    }),
  ])
  assert.equal(railRepeated.settledUpTo, railAfter.settledUpTo, 'Repeated settlement moved the rail cursor')
  assert.equal(payerRepeated.funds, payerAfter.funds, 'Repeated settlement debited the payer')
  assert.equal(payeeRepeated[0], payeeAfter[0], 'Repeated settlement credited the payee')
  console.log(
    `Exact settlement verified: rail=${dataSet.pdpRailId} rate=${expectedRate} bytes=${totalBytes} epochs=${targetEpoch - activationEpoch} gross=${expected.gross} net=${expected.netPayee}`
  )
}

async function terminateAsPayer(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint
): Promise<void> {
  assert(environment.contracts != null, 'Devnet contract exports are required')
  const before = await getPdpDataSet(synapse.client, {
    dataSetId,
    contractAddress: environment.contracts.fwssStateView,
  })
  assert(before != null, `Data set ${dataSetId} disappeared before termination`)
  const simulation = await simulateContract(synapse.client, {
    account: synapse.client.account,
    address: environment.chain.contracts.fwss.address,
    abi: fwssAbi,
    functionName: 'terminateService',
    args: [dataSetId],
  })
  const receipt = await send(synapse, simulation.request, 'Payer service termination')
  const terminatedEvents = parseEventLogs({
    abi: fwssAbi,
    logs: receipt.logs,
    eventName: 'ServiceTerminated',
    strict: false,
  })
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
      address: environment.contracts.fwssStateView,
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
}

async function main(): Promise<void> {
  const environment = resolveEnvironment({ defaultUserIndex: 0, requireFiles: true })
  assert.equal(environment.network, 'devnet', 'FWSS lifecycle regression is devnet-only')
  assert(environment.contracts != null, 'Devnet contract exports are required')
  assert.equal(environment.filePaths.length, 1, 'fwss-lifecycle.ts accepts exactly one file path')
  const [filePath] = environment.filePaths
  const metadata = freshMetadata('fwss-lifecycle')
  const synapse = createSynapse(environment)

  assert(environment.user != null, 'Selected devnet user is required')
  assert.equal(await getChainId(synapse.client), 31_415_926, 'RPC endpoint is not the expected local devnet chain')
  assert.equal(
    synapse.client.account.address.toLowerCase(),
    environment.user.evm_addr.toLowerCase(),
    'Selected devnet account does not match the exported public user'
  )

  console.log('=== FWSS business lifecycle regression ===')
  console.log(`Network: devnet run=${environment.runId}`)
  console.log(`Wallet: ${synapse.client.account.address}`)
  await assertUnauthorizedAdmin(synapse, environment)

  const prepared = await prepareAccount(synapse, await fileSize(filePath))
  const { result, milestones } = await uploadFile(synapse, filePath, metadata, 2)
  assertCompleteReplication(result, milestones)
  await assertDownloadedBytes(synapse, result.pieceCid, filePath)
  await assertDirectRetrievals(result, filePath)
  await assertOnchainState(synapse, result, metadata, prepared)

  const initialProofEpochs = await Promise.all(
    result.copies.map((copy) =>
      readContract(synapse.client, {
        address: environment.contracts!.pdpVerifier,
        abi: pdpAbi,
        functionName: 'getDataSetLastProvenEpoch',
        args: [copy.dataSetId],
      })
    )
  )
  await addSecondPieceAndValidateSignatures(synapse, environment, result.copies[1].dataSetId, filePath)
  const completedProofs = []
  for (let index = 0; index < result.copies.length; index++) {
    completedProofs.push(
      await waitForCompletedProof(
        synapse,
        environment,
        result.copies[index].dataSetId,
        initialProofEpochs[index]
      )
    )
  }
  await settleCompletedPeriod(
    synapse,
    environment,
    result.copies[0].dataSetId,
    completedProofs[0].activationEpoch,
    completedProofs[0].deadline
  )
  await terminateAsPayer(synapse, environment, result.copies[0].dataSetId)

  console.log(
    '=== SUCCESS: FWSS lifecycle scope verified: replicated upload, existing-data-set add, signature rejection, replay rejection, first-period proof, exact payment, repeat-settlement no-op, and payer termination ==='
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
