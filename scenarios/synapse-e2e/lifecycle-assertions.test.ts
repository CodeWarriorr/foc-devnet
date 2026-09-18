import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertReceiptSucceeded,
  calculateExpectedStorageRate,
  calculateSettlementAmounts,
  classifyProofPollError,
  findRevertErrorName,
} from './lifecycle-assertions.ts'

test('known Lotus state-fork read error is classified for polling retry', () => {
  const error = {
    cause: {
      code: -32002,
      message: 'required historical state unavailable: refusing explicit call due to state fork at epoch 200',
      data: 200,
    },
  }
  assert.deepEqual(classifyProofPollError(error), { retry: true, epoch: 200 })
})

test('unknown proof-poll errors remain fatal', () => {
  const errors = [
    new TypeError('data?.slice is not a function'),
    {
      code: -32002,
      message: 'required historical state unavailable: refusing explicit call due to state fork at epoch 200',
      data: '200',
    },
    {
      code: -32001,
      message: 'required historical state unavailable: refusing explicit call due to state fork at epoch 200',
      data: 200,
    },
  ]
  for (const error of errors) {
    assert.throws(
      () => classifyProofPollError(error),
      (thrown) => thrown === error
    )
  }
})

test('storage rate is derived from size and the on-chain price list', () => {
  assert.equal(
    calculateExpectedStorageRate(
      1_099_511_627_776n,
      2_500_000_000_000_000_000n,
      120_000_000_000_000_000n
    ),
    30_324_074_074_073n
  )
  assert.throws(
    () => calculateExpectedStorageRate(0n, 1n, 1n),
    /Data set size must be positive/
  )
})

test('settlement fee calculation uses ceil network fee then commission', () => {
  assert.deepEqual(calculateSettlementAmounts(10_001n, 500n), {
    gross: 10_001n,
    networkFee: 51n,
    operatorCommission: 497n,
    netPayee: 9_453n,
  })
})

test('successful receipt accepts viem and RPC success status', () => {
  assert.doesNotThrow(() => assertReceiptSucceeded({ status: 'success' }, 'viem'))
  assert.doesNotThrow(() => assertReceiptSucceeded({ status: '0x1' }, 'rpc'))
})

test('failed or missing receipt is rejected', () => {
  assert.throws(() => assertReceiptSucceeded({ status: 'reverted' }, 'failed'), /failed transaction reverted/)
  assert.throws(() => assertReceiptSucceeded(null, 'missing'), /missing transaction receipt/)
})

test('revert error name is found through nested causes', () => {
  const error = { cause: { cause: { data: { errorName: 'OwnableUnauthorizedAccount' } } } }
  assert.equal(findRevertErrorName(error), 'OwnableUnauthorizedAccount')
  assert.equal(findRevertErrorName(new Error('plain failure')), undefined)
})
