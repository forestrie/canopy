/**
 * Shared decode step for a genesis document's CBOR body: deterministic CBOR
 * decodes an integer-keyed map either as a native `Map` or as a plain
 * object (encoder-dependent), so callers that read genesis labels normalise
 * to a `Map<number, unknown>` once here rather than each re-implementing
 * the same fallback. Used by {@link decodeTrustRootFromGenesis} and
 * {@link decodeChainBindingFromGenesis}.
 */
export function decodeGenesisBodyAsIntKeyMap(
  raw: unknown,
): Map<number, unknown> | null {
  if (raw instanceof Map) return raw as Map<number, unknown>;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isFinite(n)) out.set(n, v);
    }
    return out;
  }
  return null;
}

/** Narrow a decoded genesis field to `Uint8Array`, or `null` if it is not one. */
export function asGenesisUint8Array(v: unknown): Uint8Array | null {
  return v instanceof Uint8Array ? v : null;
}
