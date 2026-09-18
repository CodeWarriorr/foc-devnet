import assert from 'node:assert/strict'

const STATE_FORK_MESSAGE =
  'required historical state unavailable: refusing explicit call due to state fork at epoch '

export function classifyProofPollError(error: unknown): { retry: true; epoch: number } {
  const seen = new Set<unknown>()
  let current = error
  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const record = current as {
      cause?: unknown
      code?: unknown
      data?: unknown
      details?: unknown
      message?: unknown
      shortMessage?: unknown
    }
    const epoch = record.data
    const messages = [record.message, record.details, record.shortMessage]
    if (
      record.code === -32002 &&
      typeof epoch === 'number' &&
      Number.isSafeInteger(epoch) &&
      epoch >= 0 &&
      messages.some(
        (message) => typeof message === 'string' && message.includes(`${STATE_FORK_MESSAGE}${epoch}`)
      )
    ) {
      return { retry: true, epoch }
    }
    current = record.cause
  }
  throw error
}

export type SettlementAmounts = {
  gross: bigint
  networkFee: bigint
  operatorCommission: bigint
  netPayee: bigint
}

const TIB_IN_BYTES = 1_099_511_627_776n
const EPOCHS_PER_MONTH = 86_400n

export function calculateExpectedStorageRate(
  totalBytes: bigint,
  storagePerTibPerMonth: bigint,
  datasetFeePerMonth: bigint
): bigint {
  assert(totalBytes > 0n, 'Data set size must be positive')
  assert(storagePerTibPerMonth >= 0n, 'Storage price cannot be negative')
  assert(datasetFeePerMonth >= 0n, 'Data set fee cannot be negative')
  return (
    (totalBytes * storagePerTibPerMonth) / (TIB_IN_BYTES * EPOCHS_PER_MONTH) +
    datasetFeePerMonth / EPOCHS_PER_MONTH
  )
}

export function calculateSettlementAmounts(gross: bigint, commissionBps: bigint): SettlementAmounts {
  assert(gross >= 0n, 'Settlement gross amount cannot be negative')
  assert(commissionBps >= 0n && commissionBps <= 10_000n, 'Commission must be valid basis points')
  const networkFee = (gross + 199n) / 200n
  const afterNetworkFee = gross - networkFee
  const operatorCommission = (afterNetworkFee * commissionBps) / 10_000n
  return {
    gross,
    networkFee,
    operatorCommission,
    netPayee: afterNetworkFee - operatorCommission,
  }
}

export function assertReceiptSucceeded(
  receipt: { status?: string | null } | null | undefined,
  label: string
): asserts receipt is { status: string } {
  assert(receipt != null, `${label} transaction receipt is missing`)
  assert(
    receipt.status === 'success' || receipt.status === '0x1',
    `${label} transaction reverted with status ${String(receipt.status)}`
  )
}

export function findRevertErrorName(error: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current = error
  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const record = current as { data?: unknown; cause?: unknown }
    if (record.data != null && typeof record.data === 'object') {
      const errorName = (record.data as { errorName?: unknown }).errorName
      if (typeof errorName === 'string') return errorName
    }
    current = record.cause
  }
  return undefined
}
