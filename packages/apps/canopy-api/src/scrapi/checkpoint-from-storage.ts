/**
 * Subplan 08 step 8.5b: Signed checkpoint from R2 (or object storage root URL) using forestrie schema.
 * Path: v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
 * Used for inclusion verification when chain config is absent or as fallback (prefer chain when both).
 */

import {
  COSE_LABEL_VDP,
  VDP_CONSISTENCY_PROOF_KEY,
  decodeCborDeterministic,
  readProtectedTreeSize2,
} from "@forestrie/encoding";
import type { Hex } from "viem";
import type { CheckpointFromStorage } from "./checkpoint-from-storage-result.js";
import type {
  LogIdUuid,
  StorageCheckpointEnv,
  StorageCheckpointEnvR2,
  StorageCheckpointEnvUrl,
} from "./storage-checkpoint-env.js";

export type {
  CheckpointFromStorage,
  LogIdUuid,
  StorageCheckpointEnv,
  StorageCheckpointEnvR2,
  StorageCheckpointEnvUrl,
} from "./types.js";

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

type DecodedCheckpointPayload = {
  proof: unknown[];
  /** Signed `tree-size-2` (protected header label -65933; ADR-0066 D1 as
   * amended). */
  signedTreeSize2: bigint;
};

/**
 * Decode checkpoint .sth (format v3, ADR-0046): a COSE Sign1 with a detached
 * (null) payload carrying its consistency proof under the verifiable-proofs
 * unprotected header (draft-bryce label 396, key `VDP_CONSISTENCY_PROOF_KEY`
 * = -2). Requires the object to decode, carry the proof, AND carry the
 * SIGNED tree-size-2 protected-header label (ADR-0066 D1 as amended, FOR-568)
 * — a checkpoint without it is not verifiable and is treated the same as
 * one with no proof at all (returns `null`).
 *
 * That equivalence holds only for an ABSENT signed tree-size-2. A PRESENT
 * protected header that is not deterministically encoded (ADR-0066 D9) is a
 * different condition — a sealer-side defect, not an ordinary unsealed
 * checkpoint — and {@link readProtectedTreeSize2} throws for it; this
 * function no longer catches that throw into the same `null` (review
 * finding O3: folding a D9 conformance failure into "no proof" made it
 * indistinguishable from the routine case and cost attribution).
 */
function decodeCheckpointPayload(
  bytes: Uint8Array,
): DecodedCheckpointPayload | null {
  const decoded = decodeCborDeterministic(bytes) as unknown;
  const unwrapped = unwrapCoseSign1Tag(decoded);
  if (!Array.isArray(unwrapped) || unwrapped.length < 4) {
    return null;
  }
  const [protectedHeader, unprotected] = unwrapped as [
    unknown,
    unknown,
    unknown,
    unknown,
  ];
  let vdp: unknown;
  if (unprotected instanceof Map) {
    vdp = unprotected.get(COSE_LABEL_VDP);
  } else if (unprotected && typeof unprotected === "object") {
    vdp = (unprotected as Record<string, unknown>)[String(COSE_LABEL_VDP)];
  }
  if (vdp === undefined || vdp === null) {
    return null;
  }
  const proofBstr =
    vdp instanceof Map
      ? vdp.get(VDP_CONSISTENCY_PROOF_KEY)
      : (vdp as Record<string, unknown>)[String(VDP_CONSISTENCY_PROOF_KEY)];
  if (!(proofBstr instanceof Uint8Array)) {
    return null;
  }
  const proof = decodeCborDeterministic(proofBstr) as unknown;
  if (!Array.isArray(proof) || proof.length < 2) {
    return null;
  }
  if (!(protectedHeader instanceof Uint8Array)) {
    return null;
  }
  const signedTreeSize2 = readProtectedTreeSize2(protectedHeader);
  if (signedTreeSize2 === null) {
    return null;
  }
  return { proof, signedTreeSize2 };
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
  return { signedTreeSize2: state.signedTreeSize2 };
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
  // The fetch/network failure is caught here and folded into `null` — a
  // storage-reachability problem, not a decode outcome. `decodeCheckpointPayload`
  // is called OUTSIDE this try so a D9 protected-header conformance failure
  // (review finding O3) propagates as a throw instead of joining the same
  // `null` a network error produces.
  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
  const state = decodeCheckpointPayload(bytes);
  if (state === null) return null;
  return { signedTreeSize2: state.signedTreeSize2 };
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
