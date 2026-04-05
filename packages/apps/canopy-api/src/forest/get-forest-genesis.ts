/**
 * `GET /api/forest/{log-id}/genesis` — public read of stored genesis CBOR.
 */

import { CBOR_CONTENT_TYPES } from "../cbor-api/cbor-content-types.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import { logIdToWireBytes, wireLogIdToHex64 } from "../grant/log-id-wire.js";
import type { GenesisCacheEnv } from "./genesis-cache.js";

export interface GetGenesisEnv extends GenesisCacheEnv {}

export async function getForestGenesis(
  logIdRouteSegment: string,
  env: GetGenesisEnv,
): Promise<Response> {
  let wire: Uint8Array;
  try {
    wire = logIdToWireBytes(logIdRouteSegment);
  } catch {
    return ClientErrors.badRequest("Invalid log-id in path");
  }

  const key = `forest/${wireLogIdToHex64(wire)}/genesis.cbor`;
  const obj = await env.R2_GRANTS.get(key);
  if (!obj) {
    return ClientErrors.notFound(
      "Not Found",
      "Genesis not found for this log-id",
    );
  }

  const body = new Uint8Array(await obj.arrayBuffer());
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": CBOR_CONTENT_TYPES.CBOR,
    },
  });
}
