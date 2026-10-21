import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { getRail } from '@filoz/synapse-core/pay'
import { getActivePieceCount } from '@filoz/synapse-core/pdp-verifier'
import { getPdpDataSet } from '@filoz/synapse-core/warm-storage'
import { getChainId } from 'viem/actions'
import type { Hash } from 'viem'
import { createSynapse, prepareAccount, type ScenarioSynapse } from './account.ts'
import { freshMetadata, resolveEnvironment, type ScenarioEnvironment } from './environment.ts'
import {
  contractsOf,
  delay,
  expectedStorageRate,
  settleExactly,
  waitForNextChallenge,
  waitForPeriodEnd,
  waitForReceipt,
} from './fwss-chain.ts'
import { createFreshContext } from './storage.ts'

function requiredEnv(name: string): string {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

function docker(...args: string[]): void {
  execFileSync('docker', args, { stdio: 'inherit' })
}

async function activePieces(synapse: ScenarioSynapse, environment: ScenarioEnvironment, dataSetId: bigint) {
  return getActivePieceCount(synapse.client, { dataSetId, contractAddress: contractsOf(environment).pdpVerifier })
}

async function assertRailMatchesSize(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  railId: bigint,
  label: string
): Promise<bigint> {
  const [{ expectedRate, totalBytes }, rail] = await Promise.all([
    expectedStorageRate(synapse, environment, dataSetId),
    getRail(synapse.client, { railId }),
  ])
  assert.equal(rail.paymentRate, expectedRate, `${label}: PDP rail rate differs from data set size and price list`)
  console.log(`${label}: rail=${railId} rate=${expectedRate} bytes=${totalBytes}`)
  return expectedRate
}

/** Polls until the provider has removed the scheduled piece at a proving-period boundary. */
async function waitForActivePieces(
  synapse: ScenarioSynapse,
  environment: ScenarioEnvironment,
  dataSetId: bigint,
  expected: bigint
): Promise<void> {
  const started = Date.now()
  const timeout = Number(process.env.FWSS_PROOF_TIMEOUT_MS ?? 900_000)
  let current = await activePieces(synapse, environment, dataSetId)
  while (current !== expected) {
    assert(Date.now() - started < timeout, `Data set ${dataSetId} kept ${current} active pieces; expected ${expected}`)
    await delay(5_000)
    current = await activePieces(synapse, environment, dataSetId)
  }
}

async function main(): Promise<void> {
  const environment = resolveEnvironment({ defaultUserIndex: 2, requireFiles: true })
  assert.equal(environment.network, 'devnet', 'FWSS proving scenario is devnet-only')
  const contracts = contractsOf(environment)
  assert.equal(environment.filePaths.length, 1, 'fwss-proving.ts accepts exactly one file path')
  const providerId = BigInt(requiredEnv('FWSS_PROVIDER_ID'))
  const providerContainer = requiredEnv('FWSS_PROVIDER_CONTAINER')
  const synapse = createSynapse(environment)
  assert.equal(await getChainId(synapse.client), 31_415_926, 'RPC endpoint is not the expected local devnet chain')

  console.log('=== FWSS proving, missed period, and piece deletion ===')
  console.log(`Network: devnet run=${environment.runId} provider=${providerId} container=${providerContainer}`)

  const kept = new Uint8Array(await readFile(environment.filePaths[0]))
  const removed = Uint8Array.from(kept)
  removed[0] ^= 0xff
  const size = BigInt(kept.byteLength)
  await prepareAccount(synapse, 2n * size)
  const context = await createFreshContext(synapse, providerId, freshMetadata('fwss-proving'))
  const preparation = await synapse.storage.prepare({ context, pieceSizes: [size, size] })
  if (preparation.transaction != null) {
    const funding = await preparation.transaction.execute({
      onHash: (hash) => console.log(`Funding submitted: ${hash}`),
    })
    console.log(`Funding confirmed: ${funding.hash}`)
  }
  const keptPiece = await context.store(kept)
  const removedPiece = await context.store(removed)
  const committed = await context.commit({
    pieces: [{ pieceCid: keptPiece.pieceCid }, { pieceCid: removedPiece.pieceCid }],
    onSubmitted: (hash) => console.log(`Commit submitted: ${hash}`),
  })
  assert.equal(committed.isNewDataSet, true, 'Fresh metadata did not create a new data set')
  assert.equal(committed.pieceIds.length, 2, 'Commit did not confirm both pieces')
  const dataSetId = committed.dataSetId
  assert.equal(await activePieces(synapse, environment, dataSetId), 2n, 'New data set must hold both pieces')
  const dataSet = await getPdpDataSet(synapse.client, { dataSetId, contractAddress: contracts.fwssStateView })
  assert(dataSet != null, `Data set ${dataSetId} is not readable`)
  assert.equal(dataSet.providerId, providerId, 'Data set was created with a different provider')
  const railId = dataSet.pdpRailId
  console.log(`Data set ${dataSetId} created with two pieces on provider ${providerId}; rail=${railId}`)

  const first = await waitForPeriodEnd(environment, dataSetId, 0n)
  assert(first.proven, 'Period 0 was not proven')

  // Pausing the provider is the only way to make a real proof go missing.
  docker('pause', providerContainer)
  console.log(`Paused ${providerContainer} for period 1`)
  let missed
  try {
    missed = await waitForPeriodEnd(environment, dataSetId, 1n)
  } finally {
    docker('unpause', providerContainer)
    console.log(`Resumed ${providerContainer}`)
  }
  assert.equal(missed.proven, false, 'Period 1 was recorded as proven while the provider was paused')

  const resumed = await waitForPeriodEnd(environment, dataSetId, 2n)
  assert(resumed.proven, 'Period 2 was not proven after the provider resumed')

  const rate = await assertRailMatchesSize(synapse, environment, dataSetId, railId, 'Two-piece rate')
  // Periods 0 and 2 are proven; FWSS pays nothing for missed period 1 or before activation.
  await settleExactly(
    synapse,
    environment,
    railId,
    resumed.deadline,
    2n * rate * first.maxProvingPeriod,
    'Settlement across a missed period'
  )

  const removalHash = (await context.deletePiece({ piece: removedPiece.pieceCid })) as Hash
  await waitForReceipt(synapse, removalHash, 'Piece deletion scheduling')
  const scheduled = await context.getScheduledRemovals()
  assert.equal(scheduled.length, 1, 'Exactly one piece must be scheduled for removal')
  assert.equal(scheduled[0], committed.pieceIds[1], 'A different piece was scheduled for removal')
  console.log(`Piece ${scheduled[0]} scheduled for removal: ${removalHash}`)

  await waitForActivePieces(synapse, environment, dataSetId, 1n)
  await waitForNextChallenge(synapse, environment, dataSetId)
  const reducedRate = await assertRailMatchesSize(synapse, environment, dataSetId, railId, 'One-piece rate')
  assert(reducedRate < rate, 'Removing a piece did not reduce the rail rate')
  assert.equal((await context.getScheduledRemovals()).length, 0, 'Removal is still scheduled after it took effect')
  const downloaded = await context.download({ pieceCid: keptPiece.pieceCid })
  assert(Buffer.from(downloaded).equals(kept), 'Remaining piece differs from uploaded bytes')

  console.log(
    '=== SUCCESS: FWSS proving scope verified: proven, missed, and resumed periods, exact settlement across the missed period, piece removal, and reduced rate ==='
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
