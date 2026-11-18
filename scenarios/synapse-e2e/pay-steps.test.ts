import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decodeRailState, isV1RailId, railPreimage, V1_RAIL_ID_LIMIT } from './pay-rails.ts'
import { isPending, parsePending, StepRunner } from './pay-steps.ts'

test('pending patterns match exact names and prefixes', () => {
  const pending = parsePending('v2.add-pieces, v2.settle.*\n# comment\n')
  assert.deepEqual(pending, ['v2.add-pieces', 'v2.settle.*'])
  assert.equal(isPending('v2.add-pieces', pending), true)
  assert.equal(isPending('v2.settle.proven', pending), true)
  assert.equal(isPending('v2.add-pieces.more', pending), false)
  assert.equal(isPending('legacy.add-pieces', pending), false)
})

test('runner classifies results and blocks dependents', async () => {
  const runner = new StepRunner('continue', ['v2.pending-*'])
  assert.equal(await runner.run('pass', [], async () => 7), 7)
  assert.equal(await runner.run('fail', [], async () => assert.fail('boom')), undefined)
  await runner.run('v2.pending-fails', [], async () => assert.fail('not yet'))
  await runner.run('v2.pending-passes', [], async () => undefined)
  let ran = false
  await runner.run('blocked', ['fail'], async () => {
    ran = true
  })
  await runner.run('after-pending', ['v2.pending-passes'], async () => undefined)
  assert.equal(ran, false)
  assert.deepEqual(
    runner.results.map((r) => [r.name, r.status]),
    [
      ['pass', 'PASS'],
      ['fail', 'FAIL'],
      ['v2.pending-fails', 'PENDING'],
      ['v2.pending-passes', 'FIXED'],
      ['blocked', 'BLOCKED'],
      ['after-pending', 'PASS'],
    ]
  )
  assert.equal(runner.failed(), true)
})

test('a pending failure alone does not fail the run', async () => {
  const runner = new StepRunner('continue', ['x'])
  await runner.run('x', [], async () => assert.fail('pending'))
  await runner.run('y', ['x'], async () => undefined)
  assert.deepEqual(runner.results.map((r) => r.status), ['PENDING', 'BLOCKED'])
  assert.equal(runner.failed(), false)
})

test('results persist across phases and only the own phase decides failure', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'pay-steps-')), 'results.json')
  const prepare = new StepRunner('prepare', [], path)
  await prepare.run('v1.setup', [], async () => undefined)
  await prepare.run('v1.broken', [], async () => assert.fail('no'))
  const proceed = new StepRunner('continue', [], path)
  assert.equal(proceed.passed('v1.setup'), true)
  await proceed.run('legacy.state', ['v1.setup'], async () => undefined)
  await proceed.run('legacy.other', ['v1.broken'], async () => undefined)
  assert.equal(proceed.failed(), false)
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual(
    saved.map((r: { phase: string; status: string }) => `${r.phase}:${r.status}`),
    ['prepare:PASS', 'prepare:FAIL', 'continue:PASS', 'continue:BLOCKED']
  )
})

test('rail preimage follows RailIdLibrary.deriveRail', () => {
  const preimage = railPreimage({
    operator: '0x1111111111111111111111111111111111111111',
    from: '0x2222222222222222222222222222222222222222',
    recipient: '0x4444444444444444444444444444444444444444',
    token: '0x3333333333333333333333333333333333333333',
    nonce: (1n << 63n) | 7n,
  })
  // operator ‖ from ‖ token ‖ recipient ‖ uint64 nonce; keccak256 of it, per `cast keccak`, is
  // 0x6ccdd3e4bce83d1e08f906edef6d657038bb0f8c8844816537b85194b3e14d08.
  assert.equal(preimage, `0x${'11'.repeat(20)}${'22'.repeat(20)}${'33'.repeat(20)}${'44'.repeat(20)}8000000000000007`)
  assert.throws(() => railPreimage({ operator: '0x11', from: '0x', recipient: '0x', token: '0x', nonce: 0n }))
})

test('rail state decodes rate, settled epoch and available', () => {
  const slot = (5n << 128n) | (1234n << 88n) | 99n
  assert.deepEqual(decodeRailState(`0x${slot.toString(16).padStart(64, '0')}`), {
    incomingRate: 99n,
    settledUpTo: 1234n,
    available: 5n,
  })
  assert.equal(isV1RailId(1n), true)
  assert.equal(isV1RailId(0n), false)
  assert.equal(isV1RailId(V1_RAIL_ID_LIMIT), false)
})
