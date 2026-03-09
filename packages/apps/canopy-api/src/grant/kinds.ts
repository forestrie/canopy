/**
 * Grant kind as single byte (uint8, Solidity-aligned). Path segment names for storage.
 */

export const KIND_BYTES = 1;
export const GRANT_FLAGS_BYTES = 8;

/** Kind byte: attestor-registration */
export const KIND_ATTESTOR = 0;
/** Kind byte: publish-checkpoint */
export const KIND_PUBLISH_CHECKPOINT = 1;

const KIND_TO_SEGMENT: Record<number, string> = {
  [KIND_ATTESTOR]: "attestor",
  [KIND_PUBLISH_CHECKPOINT]: "publish-checkpoint",
};

const SEGMENT_TO_KIND: Record<string, number> = {
  attestor: KIND_ATTESTOR,
  "publish-checkpoint": KIND_PUBLISH_CHECKPOINT,
};

export function kindByteToSegment(byte: number): string {
  const s = KIND_TO_SEGMENT[byte];
  if (s === undefined) return `kind-${byte}`;
  return s;
}

export function segmentToKindByte(segment: string): number | undefined {
  return SEGMENT_TO_KIND[segment];
}

export function kindBytesToSegment(kind: Uint8Array): string {
  if (kind.length !== 1) return "kind-invalid";
  return kindByteToSegment(kind[0]!);
}
