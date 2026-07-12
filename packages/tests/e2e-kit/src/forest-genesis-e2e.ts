/**
 * POST /api/forest/{log-id}/genesis from Playwright (Plan 0018 / 0028 / 0032).
 */

import { decode as decodeCbor } from "cbor-x";
import { encodeCborDeterministic } from "@forestrie/encoding";
import type { APIRequestContext } from "@playwright/test";
import {
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_SCHEMA_V2,
} from "./wire/forest/forest-genesis-labels.js";
import { COSE_ALG_ES256, COSE_ALG_KS256 } from "./wire/cose/cose-key.js";

export interface GenesisCoordinatorForwardStatus {
  publicRoot: "ok" | "skipped" | "error";
  webhook: "ok" | "skipped" | "error";
  detail?: string;
}

async function postGenesisWithRetry(
  request: APIRequestContext,
  logId: string,
  onboardToken: string,
  body: Uint8Array,
  label: string,
  webhookUrl?: string,
): Promise<GenesisCoordinatorForwardStatus | undefined> {
  const headers = {
    Authorization: `Bearer ${onboardToken}`,
    "Content-Type": "application/cbor",
  };
  const query = webhookUrl
    ? `?webhookUrl=${encodeURIComponent(webhookUrl)}`
    : "";
  const maxAttempts = 6;
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request.post(`/api/forest/${logId}/genesis${query}`, {
      headers,
      data: Buffer.from(body),
    });
    lastStatus = res.status();
    if (lastStatus === 201) {
      if (!webhookUrl) return undefined;
      const raw = decodeCbor(new Uint8Array(await res.body())) as {
        coordinator?: GenesisCoordinatorForwardStatus;
      };
      return raw.coordinator;
    }
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
    `${label} genesis POST for ${logId}: expected 201, got ${lastStatus}: ${lastBody}`,
  );
}

/** Store KS256 forest genesis (v2 alg + 20-byte bootstrap address). Idempotent. */
export async function ensureForestGenesisKs256E2e(
  request: APIRequestContext,
  opts: {
    logId: string;
    onboardToken: string;
    ks256Address: Uint8Array;
    univocityAddr: Uint8Array;
    chainId: string;
  },
): Promise<void> {
  if (opts.ks256Address.length !== 20) {
    throw new Error("KS256 bootstrap address must be 20 bytes");
  }
  const map = new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, opts.ks256Address],
    [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, opts.univocityAddr],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts.chainId],
  ]);
  const body = encodeCborDeterministic(map);
  await postGenesisWithRetry(
    request,
    opts.logId,
    opts.onboardToken,
    body,
    "KS256",
  );
}

/** KS256 genesis with optional coordinator webhook forward via ?webhookUrl=. */
export async function ensureForestGenesisKs256WithWebhookE2e(
  request: APIRequestContext,
  opts: {
    logId: string;
    onboardToken: string;
    ks256Address: Uint8Array;
    univocityAddr: Uint8Array;
    chainId: string;
    webhookUrl: string;
  },
): Promise<GenesisCoordinatorForwardStatus> {
  if (opts.ks256Address.length !== 20) {
    throw new Error("KS256 bootstrap address must be 20 bytes");
  }
  const map = new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, opts.ks256Address],
    [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, opts.univocityAddr],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts.chainId],
  ]);
  const body = encodeCborDeterministic(map);
  const coordinator = await postGenesisWithRetry(
    request,
    opts.logId,
    opts.onboardToken,
    body,
    "KS256+webhook",
    opts.webhookUrl,
  );
  if (!coordinator) {
    throw new Error(
      "genesis 201 missing coordinator forward status — deploy canopy-api plan-0037",
    );
  }
  if (coordinator.publicRoot !== "ok" || coordinator.webhook !== "ok") {
    throw new Error(
      `genesis coordinator forward failed: ${JSON.stringify(coordinator)}`,
    );
  }
  return coordinator;
}

/** Store ES256 forest genesis (v2 alg + 64-byte x‖y bootstrapKey). Idempotent. */
export async function ensureForestGenesisEs256E2e(
  request: APIRequestContext,
  opts: {
    logId: string;
    onboardToken: string;
    bootstrapKey: Uint8Array;
    univocityAddr: Uint8Array;
    chainId: string;
  },
): Promise<void> {
  if (opts.bootstrapKey.length !== 64) {
    throw new Error("ES256 bootstrapKey must be 64 bytes (x||y)");
  }
  const map = new Map<number, unknown>([
    [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
    [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_ES256],
    [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, opts.bootstrapKey],
    [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, opts.univocityAddr],
    [FOREST_GENESIS_LABEL_CHAIN_ID, opts.chainId],
  ]);
  const body = encodeCborDeterministic(map);
  await postGenesisWithRetry(
    request,
    opts.logId,
    opts.onboardToken,
    body,
    "ES256",
  );
}
