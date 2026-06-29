/**
 * Helpers for CBOR-decoded maps keyed by integers (COSE_Key, application-private labels, etc.).
 */

export function decodeBodyAsIntKeyMap(
  raw: unknown,
): Map<number, unknown> | null {
  if (raw instanceof Map) {
    const m = new Map<number, unknown>();
    for (const [k, v] of raw) {
      const kn = typeof k === "number" ? k : Number(k);
      if (!Number.isFinite(kn)) return null;
      m.set(kn, v);
    }
    return m;
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const m = new Map<number, unknown>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const kn = Number(k);
      if (!Number.isFinite(kn)) return null;
      m.set(kn, v);
    }
    return m;
  }
  return null;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}
