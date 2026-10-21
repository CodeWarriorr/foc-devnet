import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { getRail } from '@filoz/synapse-core/pay'
import { getChainId, readContract, simulateContract } from 'viem/actions'
import { createSynapse, prepareAccount, type ScenarioSynapse } from './account.ts'
import { resolveEnvironment, type ScenarioEnvironment } from './environment.ts'
import {
  assertAddRejected,
  contractsOf,
  createDataSet,
  dataSetRecord,
  depositHeadroom,
  expectedProvenGross,
  fwssAbi,
  settleCdnExactly,
  settleExactly,
  stateViewAbi,
  terminateAsPayer,
  terminateCdnService,
  waitForCurrentPeriodEnd,
  waitForPeriodEnd,
} from './fwss-chain.ts'
import { findRevertErrorName } from './lifecycle-assertions.ts'

async function assertNotController(label: string, simulate: () => Promise<unknown>): Promise<void> {
  try {
    await simulate()
  } catch (error) {
    assert.equal(findRevertErrorName(error), 'OnlyFilBeamControllerAllowed', `${label} failed for an unexpected reason`)
    return
  }
  throw new Error(`${label} was accepted`)
}

/** Settles the PDP rail from its cursor to `untilEpoch`, paying exactly the proven epochs. */
async function settleProven(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  railId: bigint,
  untilEpoch: bigint,
  label: string
): Promise<bigint> {
  const rail = await getRail(synapse.client, { railId })
  const { gross } = await expectedProvenGross(synapse, environment, dataSetId, railId, rail.settledUpTo, untilEpoch)
  await settleExactly(synapse, environment, railId, untilEpoch, gross, label)
  return gross
}

async function main(): Promise<void> {
  const environment = resolveEnvironment({ defaultUserIndex: 1, requireFiles: true })
  assert.equal(environment.network, 'devnet', 'FWSS CDN scenario is devnet-only')
  const contracts = contractsOf(environment)
  assert.equal(environment.filePaths.length, 1, 'fwss-cdn.ts accepts exactly one file path')
  const providerIdValue = process.env.FWSS_PROVIDER_ID
  assert(providerIdValue != null && /^\d+$/.test(providerIdValue), 'FWSS_PROVIDER_ID is required')
  const providerId = BigInt(providerIdValue)
  const synapse = createSynapse(environment)
  assert.equal(await getChainId(synapse.client), 31_415_926, 'RPC endpoint is not the expected local devnet chain')

  console.log('=== FWSS FilBeam CDN service and termination ===')
  console.log(`Network: devnet run=${environment.runId} provider=${providerId}`)

  const source = new Uint8Array(await readFile(environment.filePaths[0]))
  await prepareAccount(synapse, BigInt(source.byteLength))
  await depositHeadroom(synapse)
  const created = await createDataSet(synapse, providerId, [source], 'fwss-cdn', true)
  const dataSetId = created.committed.dataSetId
  const info = await dataSetRecord(synapse, environment, dataSetId)
  assert(info.cdnRailId > 0n && info.cacheMissRailId > 0n, 'CDN data set has no FilBeam rails')
  const cdn = { dataSetId, cdnRailId: info.cdnRailId, cacheMissRailId: info.cacheMissRailId, pdpRailId: info.pdpRailId }
  const [cdnRail, cacheMissRail] = await Promise.all(
    [cdn.cdnRailId, cdn.cacheMissRailId].map((railId) => getRail(synapse.client, { railId }))
  )
  for (const [name, rail] of [
    ['CDN', cdnRail],
    ['Cache-miss', cacheMissRail],
  ] as const) {
    assert.equal(rail.from.toLowerCase(), synapse.client.account.address.toLowerCase(), `${name} rail has another payer`)
    assert.equal(rail.paymentRate, 0n, `${name} rail streams payments; FilBeam settles it from its lockup`)
    assert(rail.lockupFixed > 0n, `${name} rail has no lockup for FilBeam to settle from`)
  }
  const [hasCdn] = await readContract(synapse.client, {
    address: contracts.fwssStateView,
    abi: stateViewAbi,
    functionName: 'getDataSetMetadata',
    args: [dataSetId, 'withCDN'],
  })
  assert.equal(hasCdn, true, 'CDN data set has no withCDN metadata')
  console.log(`CDN data set ${dataSetId}: pdp=${cdn.pdpRailId} cdn=${cdn.cdnRailId} cacheMiss=${cdn.cacheMissRailId}`)

  // Only the FilBeam controller may settle or end the CDN service.
  const fwss = environment.chain.contracts.fwss.address
  const account = synapse.client.account
  await assertNotController('FilBeam settlement by the payer', () =>
    simulateContract(synapse.client, {
      account,
      address: fwss,
      abi: fwssAbi,
      functionName: 'settleFilBeamPaymentRails',
      args: [dataSetId, 1n, 1n],
    })
  )
  await assertNotController('CDN termination by the payer', () =>
    simulateContract(synapse.client, {
      account,
      address: fwss,
      abi: fwssAbi,
      functionName: 'terminateCDNService',
      args: [dataSetId],
    })
  )
  await settleCdnExactly(synapse, environment, cdn, 1_000n, 2_000n, 'FilBeam settlement')

  const first = await waitForPeriodEnd(environment, dataSetId, 0n)
  assert(first.proven, `First proving period of CDN data set ${dataSetId} was not proven`)
  const firstGross = await settleProven(synapse, environment, dataSetId, cdn.pdpRailId, first.deadline, 'PDP rail settlement')
  assert(firstGross > 0n, 'A proven period paid nothing')

  await terminateCdnService(synapse, environment, cdn, 'CDN termination')

  // Signed while the data set is live, to show that termination closes it to adds.
  const extraData = await created.context.presignForCommit([{ pieceCid: created.stored[0].pieceCid }])
  const endEpoch = await terminateAsPayer(synapse, environment, dataSetId)
  await assertAddRejected(
    synapse,
    environment,
    dataSetId,
    created.stored[0].pieceCid,
    extraData,
    'DataSetPaymentAlreadyTerminated',
    'Add to a terminated data set'
  )

  // Until its end epoch, the terminated rail still pays for proven periods only.
  const after = await waitForCurrentPeriodEnd(synapse, environment, dataSetId)
  assert(after.deadline < endEpoch, 'The settlement target passed the termination end epoch')
  await settleProven(synapse, environment, dataSetId, cdn.pdpRailId, after.deadline, 'PDP rail settlement after termination')

  console.log(
    '=== SUCCESS: FWSS CDN scope verified: FilBeam rails, controller-only settlement and termination, exact CDN and PDP settlement, CDN termination, payer termination, closed adds, and exact settlement after termination ==='
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
