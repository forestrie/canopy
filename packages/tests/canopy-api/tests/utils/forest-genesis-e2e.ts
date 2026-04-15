/**
 * POST /api/forest/{log-id}/genesis from Playwright (Plan 0018 / 0019).
 */

import { encode as encodeCbor } from "cbor-x";
import type { APIRequestContext } from "@playwright/test";
import {
  COSE_ALG_ES256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "@e2e-canopy-api-src/cose/cose-key.js";

/**
 * Store forest genesis for e2e. Idempotent: **409** (already exists) is OK.
 */
export async function ensureForestGenesisE2e(
  request: APIRequestContext,
  opts: {
    logId: string;
    curatorToken: string;
    x: Uint8Array;
    y: Uint8Array;
  },
): Promise<void> {
  const map = new Map<number, unknown>([
    [COSE_KEY_KTY, COSE_KTY_EC2],
    [COSE_EC2_CRV, COSE_CRV_P256],
    [COSE_EC2_X, opts.x],
    [COSE_EC2_Y, opts.y],
    [COSE_KEY_ALG, COSE_ALG_ES256],
  ]);
  const body = encodeCbor(map) as Uint8Array;
  const res = await request.post(`/api/forest/${opts.logId}/genesis`, {
    headers: {
      Authorization: `Bearer ${opts.curatorToken}`,
      "Content-Type": "application/cbor",
    },
    data: Buffer.from(body),
  });
  const st = res.status();
  if (st !== 201 && st !== 409) {
    throw new Error(
      `genesis POST for ${opts.logId}: expected 201 or 409, got ${st}: ${(await res.text()).slice(0, 500)}`,
    );
  }
}
