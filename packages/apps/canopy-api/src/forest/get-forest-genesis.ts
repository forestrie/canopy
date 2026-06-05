/**
 * `GET /api/forest/{log-id}/genesis` — public read of stored genesis CBOR.
 */

import { CBOR_CONTENT_TYPES } from "../cbor-api/cbor-content-types.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import { logIdToWireBytes, wireLogIdToHex64 } from "../grant/log-id-wire.js";
import type { GenesisCacheEnv } from "./genesis-cache.js";

export interface GetGenesisEnv extends GenesisCacheEnv {
  /**
   * When set, a R2 miss falls back to the univocity owned store (authoritative).
   * Lets canopy serve genesis after storage moves to univocity while the R2
   * compat shim is phased out (plan-0029).
   */
  UNIVOCITY_SERVICE_URL?: string;
  UNIVOCITY_API_TOKEN?: string;
}

async function proxyGenesisFromUnivocity(
  env: GetGenesisEnv,
  hex64: string,
): Promise<Response | null> {
  const serviceUrl = env.UNIVOCITY_SERVICE_URL?.trim();
  if (!serviceUrl) return null;
  const token = env.UNIVOCITY_API_TOKEN?.trim();
  try {
    const res = await fetch(
      `${serviceUrl.replace(/\/+$/, "")}/api/forest/${hex64}/genesis`,
      {
        method: "GET",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      },
    );
    if (!res.ok) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": CBOR_CONTENT_TYPES.CBOR },
    });
  } catch {
    return null;
  }
}

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

  const hex64 = wireLogIdToHex64(wire);
  const key = `forest/${hex64}/genesis.cbor`;
  const obj = await env.R2_GRANTS.get(key);
  if (!obj) {
    const proxied = await proxyGenesisFromUnivocity(env, hex64);
    if (proxied) return proxied;
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
