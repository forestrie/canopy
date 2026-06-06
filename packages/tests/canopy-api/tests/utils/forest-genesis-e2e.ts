/**
 * POST /api/forest/{log-id}/genesis from Playwright (Plan 0018 / 0019 / 0028).
 */

import { encode as encodeCbor } from "cbor-x";
import type { APIRequestContext } from "@playwright/test";
import {
  FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
  FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V1,
  FOREST_GENESIS_SCHEMA_V2,
} from "@e2e-canopy-api-src/forest/forest-genesis-labels.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "@e2e-canopy-api-src/cose/cose-key.js";

export {
  FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
  FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
};

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
    univocityAddr?: Uint8Array;
    chainId?: string;
  },
): Promise<void> {
  const map = new Map<number, unknown>([
    [COSE_KEY_KTY, COSE_KTY_EC2],
    [COSE_EC2_CRV, COSE_CRV_P256],
    [COSE_EC2_X, opts.x],
    [COSE_EC2_Y, opts.y],
    [COSE_KEY_ALG, COSE_ALG_ES256],
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V1],
    [
      FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
      opts.univocityAddr ?? FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
    ],
    [
      FOREST_GENESIS_LABEL_CHAIN_ID,
      opts.chainId ?? FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
    ],
  ]);
  const body = encodeCbor(map) as Uint8Array;
  const headers = {
    Authorization: `Bearer ${opts.curatorToken}`,
    "Content-Type": "application/cbor",
  };

  // Worker→univocity genesis forward can transiently 502 at Traefik; backoff and retry.
  const maxAttempts = 6;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request.post(`/api/forest/${opts.logId}/genesis`, {
      headers,
      data: Buffer.from(body),
    });
    lastStatus = res.status();
    if (lastStatus === 201 || lastStatus === 409) return;
    lastBody = (await res.text()).slice(0, 500);
    const transient =
      lastStatus >= 500 ||
      (lastStatus === 503 &&
        lastBody.includes("univocity genesis returned 502"));
    if (attempt < maxAttempts && transient) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    break;
  }
  throw new Error(
    `genesis POST for ${opts.logId}: expected 201 or 409, got ${lastStatus}: ${lastBody}`,
  );
}

/** Store KS256 forest genesis (v2 alg + 20-byte bootstrap address). Idempotent. */
export async function ensureForestGenesisKs256E2e(
  request: APIRequestContext,
  opts: {
    logId: string;
    curatorToken: string;
    ks256Address: Uint8Array;
    univocityAddr?: Uint8Array;
    chainId?: string;
  },
): Promise<void> {
  if (opts.ks256Address.length !== 20) {
    throw new Error("KS256 bootstrap address must be 20 bytes");
  }
  const map = new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, opts.ks256Address],
    [
      FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
      opts.univocityAddr ?? FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
    ],
    [
      FOREST_GENESIS_LABEL_CHAIN_ID,
      opts.chainId ?? FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
    ],
  ]);
  const body = encodeCbor(map) as Uint8Array;
  const headers = {
    Authorization: `Bearer ${opts.curatorToken}`,
    "Content-Type": "application/cbor",
  };
  const maxAttempts = 6;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request.post(`/api/forest/${opts.logId}/genesis`, {
      headers,
      data: Buffer.from(body),
    });
    lastStatus = res.status();
    if (lastStatus === 201 || lastStatus === 409) return;
    lastBody = (await res.text()).slice(0, 500);
    const transient =
      lastStatus >= 500 ||
      (lastStatus === 503 &&
        lastBody.includes("univocity genesis returned 502"));
    if (attempt < maxAttempts && transient) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    break;
  }
  throw new Error(
    `KS256 genesis POST for ${opts.logId}: expected 201 or 409, got ${lastStatus}: ${lastBody}`,
  );
}
