// FilecoinPayV2 rail encoding, kept free of dependencies so lint can unit-test it.

/** FilecoinPayV2 settles a rail with this nonce bit through the operator's IRailV2.settleRail. */
export const FLAG_CALLBACK = 1n << 63n
/** FWSS marks its CDN rail's nonce with this bit. */
export const CDN_NONCE_FLAG = 1n << 62n
/** FilecoinPayV1 counts rail ids up from one; FilecoinPayV2 rail ids are storage-slot hashes. */
export const V1_RAIL_ID_LIMIT = 1n << 64n
/** Permissions bit a payer grants FWSS so it can open rails on the payer's behalf. */
export const CREATE_RAIL = 1n << 3n

/** The identity FilecoinPayV2 derives a rail from; its rail id is the hash of these fields. */
export type RailKey = { operator: `0x${string}`; from: `0x${string}`; recipient: `0x${string}`; token: `0x${string}`; nonce: bigint }

export type RailStateV2 = { incomingRate: bigint; settledUpTo: bigint; available: bigint }

function word(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an address: ${address}`)
  return address.slice(2).toLowerCase()
}

/** RailIdLibrary.deriveRail hashes operator ‖ from ‖ token ‖ recipient ‖ uint64 nonce, in that order. */
export function railPreimage(key: RailKey): `0x${string}` {
  if (key.nonce < 0n || key.nonce >= 1n << 64n) throw new Error(`Nonce ${key.nonce} does not fit uint64`)
  return `0x${word(key.operator)}${word(key.from)}${word(key.token)}${word(key.recipient)}${key.nonce.toString(16).padStart(16, '0')}`
}

/** Mirrors RailIdLibrary.getRail: rate in the low 88 bits, then a 40-bit settled epoch, then 128-bit available. */
export function decodeRailState(slot: `0x${string}`): RailStateV2 {
  const value = BigInt(slot)
  return {
    incomingRate: value & ((1n << 88n) - 1n),
    settledUpTo: (value >> 88n) & ((1n << 40n) - 1n),
    available: value >> 128n,
  }
}

export function isV1RailId(railId: bigint): boolean {
  return railId > 0n && railId < V1_RAIL_ID_LIMIT
}
