/**
 * Serve grant document with lazy completion (Plan 0004 subplan 03).
 * GET /grants/authority/{innerHex} — load grant from R2, resolveContent(inner); if sequenced, merge idtimestamp and return full grant CBOR.
 */

import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";
import { shardNameForLog } from "@canopy/forestrie-sharding";
import { decodeGrant, encodeGrant } from "../grant/codec.js";
import type { Grant } from "../grant/types.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { ClientErrors, ServerErrors } from "./problem-details";
import {
  mmrIndexFromLeafIndex,
  readIdtimestampFromMassif,
} from "./sequencing-result.js";

const SEQUENCED_GRANT_KIND_SEGMENT = "authority";

function getShardCount(shardCountStr: string): number {
  const count = parseInt(shardCountStr, 10);
  if (Number.isNaN(count) || count < 1) return 1;
  return count;
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function writeU64BE(out: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 7; i >= 0; i--) {
    out[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

export interface ServeGrantEnv {
  r2Grants: R2Bucket;
  r2Mmrs: R2Bucket;
  sequencingQueue: DurableObjectNamespace;
  shardCountStr: string;
  massifHeight: number;
}

/**
 * Load grant from R2 at authority/{innerHex}.cbor, resolve sequencing; if complete, merge idtimestamp and return grant CBOR.
 */
export async function serveGrant(
  innerHex: string,
  env: ServeGrantEnv,
): Promise<Response> {
  if (innerHex.length !== 64 || !/^[0-9a-f]+$/i.test(innerHex)) {
    return ClientErrors.badRequest("innerHex must be 64 hex characters");
  }

  const storageKey = `${SEQUENCED_GRANT_KIND_SEGMENT}/${innerHex.toLowerCase()}.cbor`;
  const obj = await env.r2Grants.get(storageKey);
  if (!obj) {
    return ClientErrors.notFound("Grant not found");
  }

  const bytes = new Uint8Array(await obj.arrayBuffer());
  let grant: Grant;
  try {
    grant = decodeGrant(bytes);
  } catch {
    return ServerErrors.internal("Grant decode failed");
  }

  const ownerLogIdUuid = bytesToUuid(grant.ownerLogId);
  const shardCount = getShardCount(env.shardCountStr);
  const shardName = shardNameForLog(ownerLogIdUuid, shardCount);
  const doId = env.sequencingQueue.idFromName(shardName);
  const queue = env.sequencingQueue.get(doId) as unknown as SequencingQueueStub;

  const contentHashBytes = hexToBuffer(innerHex.toLowerCase());
  const result = await queue.resolveContent(contentHashBytes);

  if (!result) {
    return new Response(null, {
      status: 202,
      headers: {
        "Retry-After": "5",
        "Content-Type": "application/cbor",
      },
    });
  }

  const idtimestamp = await readIdtimestampFromMassif(
    env.r2Mmrs,
    ownerLogIdUuid,
    env.massifHeight,
    result.massifIndex,
    result.leafIndex,
  );
  const mmrIndex = mmrIndexFromLeafIndex(result.leafIndex);

  const idtimestampBytes = new Uint8Array(8);
  writeU64BE(idtimestampBytes, 0, idtimestamp);

  const completedGrant: Grant = {
    ...grant,
    idtimestamp: idtimestampBytes,
  };

  const encoded = encodeGrant(completedGrant);
  return new Response(encoded, {
    status: 200,
    headers: {
      "Content-Type": "application/cbor",
      "Content-Length": String(encoded.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

/**
 * Fetch a completed grant by path (for register-statement X-Grant-Location).
 * When path is /grants/authority/{innerHex}, loads from R2 and completes with resolveContent + idtimestamp.
 * Returns null if grant not found or not yet sequenced.
 */
export async function getCompletedGrant(
  path: string,
  env: ServeGrantEnv,
): Promise<{ grant: Grant; bytes: Uint8Array } | null> {
  const match = /^\/grants\/authority\/([0-9a-f]{64})$/i.exec(path);
  if (!match) return null;

  const innerHex = match[1]!.toLowerCase();
  const storageKey = `${SEQUENCED_GRANT_KIND_SEGMENT}/${innerHex}.cbor`;
  const obj = await env.r2Grants.get(storageKey);
  if (!obj) return null;

  const bytes = new Uint8Array(await obj.arrayBuffer());
  let grant: Grant;
  try {
    grant = decodeGrant(bytes);
  } catch {
    return null;
  }

  const ownerLogIdUuid = bytesToUuid(grant.ownerLogId);
  const shardCount = getShardCount(env.shardCountStr);
  const shardName = shardNameForLog(ownerLogIdUuid, shardCount);
  const doId = env.sequencingQueue.idFromName(shardName);
  const queue = env.sequencingQueue.get(doId) as unknown as SequencingQueueStub;

  const contentHashBytes = hexToBuffer(innerHex);
  const result = await queue.resolveContent(contentHashBytes);
  if (!result) return null;

  const idtimestamp = await readIdtimestampFromMassif(
    env.r2Mmrs,
    ownerLogIdUuid,
    env.massifHeight,
    result.massifIndex,
    result.leafIndex,
  );

  const idtimestampBytes = new Uint8Array(8);
  writeU64BE(idtimestampBytes, 0, idtimestamp);

  const completedGrant: Grant = {
    ...grant,
    idtimestamp: idtimestampBytes,
  };

  return {
    grant: completedGrant,
    bytes: encodeGrant(completedGrant),
  };
}
