/**
 * R2_MMRS-specific helpers and minimal types used by ranger cache.
 *
 * This module abstracts over the Cloudflare R2Bucket binding so the rest
 * of the code only depends on the small surface it needs.
 */

export interface RangerR2ObjectBody {
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RangerR2Bucket {
  get(key: string): Promise<RangerR2ObjectBody | null>;
}

/**
 * Minimal representation of the payload we expect on the queue for an
 * R2_MMRS object change notification.
 */
export interface R2ObjectReference {
  bucket: string;
  key: string;
  etag?: string;
}

/**
 * Convert an arbitrary queue message body into an R2ObjectReference.
 *
 * The concrete shape of the queue payload is owned by the producer; this
 * function keeps that parsing logic in one place.
 */
export function toR2ObjectReference(body: unknown): R2ObjectReference | null {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as any).key !== "string"
  ) {
    return null;
  }

  const { bucket, key, etag } = body as any;

  return {
    bucket: typeof bucket === "string" ? bucket : "R2_MMRS",
    key,
    etag: typeof etag === "string" ? etag : undefined,
  };
}
