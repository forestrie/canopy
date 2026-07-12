/**
 * After sequencing completes, set unprotected -65537 on the univocity-owned
 * grant store so publishers bind the correct leaf commitment.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import type { UnivocityGrantClient } from "./univocity-grant-client-config.js";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function u64Be8(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = n & 0xffffffffffffffffn;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Best-effort patch of the stored grant's sequenced idtimestamp.
 * Failures are logged; callers should not block receipt redirect on this.
 */
export async function patchGrantIdtimestamp(opts: {
  client: UnivocityGrantClient;
  /** Forest root R (bootstrap log UUID). */
  rootLogId: string;
  /** Grant subject log UUID (T). */
  subjectLogId: string;
  idtimestamp: bigint;
}): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  const body = encodeCborDeterministic({
    idtimestamp: u64Be8(opts.idtimestamp),
  });

  const path = `/api/forest/${opts.rootLogId}/grants/${opts.subjectLogId}/idtimestamp`;
  let res: Response;
  try {
    res = await fetch(joinUrl(opts.client.serviceUrl, path), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/cbor",
        Authorization: `Bearer ${opts.client.token}`,
      },
      body,
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      detail: e instanceof Error ? e.message : "univocity unreachable",
    };
  }

  if (res.status === 204 || res.status === 200) {
    return { ok: true };
  }
  const detail = (await res.text().catch(() => "")).slice(0, 256);
  return { ok: false, status: res.status, detail };
}
