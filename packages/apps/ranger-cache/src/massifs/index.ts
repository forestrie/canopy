/**
 * Massif-related helpers.
 *
 * This module is where we hide the specifics of the go-merklog/massifs
 * layout. For now it only exposes helpers that are convenient to test
 * and reason about; the actual rules can be filled in later.
 */

export interface MassifCoordinate {
  logId: string;
  index: number;
}

/**
 * Derive a stable cache key for a massif from its logical coordinate.
 */
export function deriveMassifCacheKey(ref: MassifCoordinate): string {
  return `logs/${ref.logId}/massifs/${ref.index}`;
}

/**
 * Parse a massif coordinate from a raw R2_MMRS object key.
 *
 * This implementation is a placeholder that assumes keys of the form:
 *   logs/{logId}/massifs/{index}.cbor
 */
export function parseMassifCoordinateFromKey(
  objectKey: string,
): MassifCoordinate | null {
  const parts = objectKey.split("/");
  if (parts.length < 4) return null;

  const [logsLiteral, logId, massifsLiteral, indexWithExt] = parts.slice(-4);
  if (logsLiteral !== "logs" || massifsLiteral !== "massifs") return null;

  const [indexPart] = indexWithExt.split(".");
  const index = Number.parseInt(indexPart, 10);
  if (!Number.isFinite(index)) return null;

  return { logId, index };
}
