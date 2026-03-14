/**
 * Subplan 08 §3.3.1: Verify grant included in owner log.
 * Checkpoint source: chain (univocal contracts) and/or storage (R2 or object storage root URL).
 * At least one source required; when both are configured, prefer chain. Caching may be added later.
 * 1) resolveContent(inner) → if null, not sequenced → false.
 * 2) Obtain checkpoint from chain (preferred) or storage; if none, false.
 * Full MMR verification (leaf in tree, root matches checkpoint) can be added later.
 */

import { getQueueForLog } from "../sequeue/logshard.js";
import type { Grant } from "../grant/types.js";
import { innerHashFromGrant } from "../grant/inner-hash.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import {
  getUnivocalCheckpointFromContracts,
  type UnivocalCheckpointEnv,
} from "./univocal-checkpoint.js";
import {
  getCheckpointFromStorage,
  type StorageCheckpointEnv,
} from "./checkpoint-from-storage.js";

/** Shared env for resolveContent (DO). */
export interface InclusionBaseEnv {
  sequencingQueue: DurableObjectNamespace;
  shardCountStr: string;
}

/**
 * Unified inclusion env: at least one of chain or storage must be set.
 * When both are set, verification prefers chain.
 */
export interface InclusionEnv extends InclusionBaseEnv {
  chain?: UnivocalCheckpointEnv;
  storage?: StorageCheckpointEnv;
}

/** @deprecated Use InclusionEnv with chain only; kept for compatibility. */
export interface VerifyInclusionEnv extends InclusionBaseEnv {
  univocityContractRpcUrl: string;
  univocityContractAddress: string;
}

function hexToBytes(hex: string): ArrayBuffer {
  const s = hex.replace(/^0x/i, "").trim().toLowerCase();
  const bytes = new Uint8Array(s.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function ownerLogIdToHex(ownerLogIdBytes: Uint8Array): string {
  const bytes =
    ownerLogIdBytes.length >= 32
      ? ownerLogIdBytes.slice(-32)
      : ownerLogIdBytes;
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .padStart(64, "0")
  );
}

/**
 * Verify grant is included in its owner log.
 * Uses chain and/or storage for checkpoint; requires at least one; prefers chain when both present.
 */
export async function verifyGrantIncluded(
  grant: Grant,
  env: InclusionEnv,
): Promise<boolean> {
  const ownerLogIdBytes = grant.ownerLogId as Uint8Array;
  const ownerLogIdUuid = bytesToUuid(ownerLogIdBytes);

  const inner = await innerHashFromGrant(grant);
  const innerHex = Array.from(inner)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const contentHashBytes = hexToBytes(innerHex);

  const queue = getQueueForLog(env, ownerLogIdUuid);

  const result = await queue.resolveContent(contentHashBytes);
  if (result === null) return false;

  const hasChain = !!(
    env.chain?.univocityContractRpcUrl?.trim() &&
    env.chain?.univocityContractAddress?.trim()
  );
  const hasStorage = !!env.storage;

  if (!hasChain && !hasStorage) {
    return false;
  }

  if (hasChain) {
    const ownerLogIdHex = ownerLogIdToHex(ownerLogIdBytes).replace(/^0x/, "");
    try {
      const checkpoint = await getUnivocalCheckpointFromContracts(
        ownerLogIdHex,
        env.chain!,
      );
      if (checkpoint) return true;
    } catch {
      // Fall through to storage if chain fails
    }
  }

  if (hasStorage) {
    const checkpoint = await getCheckpointFromStorage(
      ownerLogIdUuid,
      result.massifIndex,
      env.storage!,
    );
    if (checkpoint !== null) return true;
  }

  return false;
}

/**
 * Verify grant included using only chain checkpoint (legacy / backward compat).
 * Prefer verifyGrantIncluded with unified InclusionEnv.
 */
export async function verifyGrantIncludedAgainstCheckpoint(
  grant: Grant,
  env: VerifyInclusionEnv,
): Promise<boolean> {
  return verifyGrantIncluded(grant, {
    sequencingQueue: env.sequencingQueue,
    shardCountStr: env.shardCountStr,
    chain: {
      univocityContractRpcUrl: env.univocityContractRpcUrl,
      univocityContractAddress: env.univocityContractAddress,
    },
  });
}
