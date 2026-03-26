/**
 * Subplan 08 step 8.5b: Signed checkpoint from R2 (or object storage root URL) using forestrie schema.
 * Path: v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
 * Used for inclusion verification when chain config is absent or as fallback (prefer chain when both).
 */

import { decode as decodeCbor } from "cbor-x";
import type { Hex } from "viem";

/** Log ID as UUID string (ownerLogId from grant). */
export type LogIdUuid = string;

/** Storage config: R2 bucket (Workers binding) for massifs/checkpoints. */
export interface StorageCheckpointEnvR2 {
  r2Mmrs: R2Bucket;
  massifHeight: number;
}

/** Storage config: base URL to fetch checkpoint objects by path (e.g. public R2 or CDN). */
export interface StorageCheckpointEnvUrl {
  objectStorageRootUrl: string;
  massifHeight: number;
}

export type StorageCheckpointEnv =
  | StorageCheckpointEnvR2
  | StorageCheckpointEnvUrl;

export interface CheckpointFromStorage {
  /** MMR root when present in checkpoint payload; optional for minimal verification. */
  mmrRoot?: Hex;
}

function formatObjectIndex16(massifIndex: number): string {
  return massifIndex.toString(10).padStart(16, "0");
}

function checkpointPath(
  logId: LogIdUuid,
  massifHeight: number,
  massifIndex: number,
): string {
  const objectIndex = formatObjectIndex16(massifIndex);
  return `v2/merklelog/checkpoints/${massifHeight}/${logId}/${objectIndex}.sth`;
}

/**
 * Unwrap COSE Sign1 (tag 18) and return inner value if present.
 */
function unwrapCoseSign1Tag(value: unknown): unknown {
  if (value && typeof value === "object" && !(value instanceof Map)) {
    const tagged = value as { tag?: number; value?: unknown };
    if (
      Object.prototype.hasOwnProperty.call(tagged, "value") &&
      tagged.tag === 18
    ) {
      return tagged.value;
    }
  }
  return value;
}

/**
 * Decode checkpoint .sth: CBOR, optionally COSE Sign1-tagged; payload is state (e.g. MMR size at key 1).
 * MMR root may be in state; for now we only require that we could read and decode the checkpoint.
 */
function decodeCheckpointPayload(bytes: Uint8Array): unknown {
  const decoded = decodeCbor(bytes) as unknown;
  const unwrapped = unwrapCoseSign1Tag(decoded);
  if (!Array.isArray(unwrapped) || unwrapped.length < 3) {
    return null;
  }
  const payload = (unwrapped as [unknown, unknown, Uint8Array | null])[2];
  if (!(payload instanceof Uint8Array) || payload.length === 0) {
    return null;
  }
  return decodeCbor(payload) as unknown;
}

/**
 * Get signed checkpoint for a log at a given massif index from R2.
 */
async function getCheckpointFromR2(
  logId: LogIdUuid,
  massifIndex: number,
  env: StorageCheckpointEnvR2,
): Promise<CheckpointFromStorage | null> {
  const path = checkpointPath(logId, env.massifHeight, massifIndex);
  const obj = await env.r2Mmrs.get(path);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const state = decodeCheckpointPayload(bytes);
  if (state === null) return null;
  // Minimal success: we read and decoded the checkpoint. MMR root extraction can be added when state schema is fixed.
  return {};
}

/**
 * Get signed checkpoint for a log at a given massif index from object storage root URL.
 */
async function getCheckpointFromUrl(
  logId: LogIdUuid,
  massifIndex: number,
  env: StorageCheckpointEnvUrl,
): Promise<CheckpointFromStorage | null> {
  const path = checkpointPath(logId, env.massifHeight, massifIndex);
  const base = env.objectStorageRootUrl.replace(/\/$/, "");
  const url = `${base}/${path}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const state = decodeCheckpointPayload(bytes);
    if (state === null) return null;
    return {};
  } catch {
    return null;
  }
}

/**
 * Get signed checkpoint for ownerLogId at the given massif index from storage (R2 or URL).
 * Returns a value when the .sth object exists and decodes; MMR root may be added when schema is defined.
 */
export async function getCheckpointFromStorage(
  logId: LogIdUuid,
  massifIndex: number,
  env: StorageCheckpointEnv,
): Promise<CheckpointFromStorage | null> {
  if ("r2Mmrs" in env) {
    return getCheckpointFromR2(logId, massifIndex, env);
  }
  return getCheckpointFromUrl(logId, massifIndex, env);
}
