/**
 * Poll helpers for Mode C webhook-driven delegation sealing (plan-0037).
 */

import type { APIRequestContext } from "@playwright/test";
import { decode } from "cbor-x";
import {
  E2E_POLL_MAX_WAIT_MS,
  sequencingBackoff,
  sleepMs,
} from "./arithmetic-backoff-poll.js";
import type { ModeCWebhookReceiverStats } from "../system/helpers/mode-c-webhook-receiver.js";
import { submitModeCKs256DelegationMaterial } from "../system/helpers/mode-c-webhook-receiver.js";
import { modeCAllowPullFallback } from "./mode-c-e2e-env.js";
import { extractDelegationCertFromReceipt } from "./byok-wallet-seal-helpers.js";
import {
  bytesToBase64,
  verifyKs256BootstrapDelegationCertificate,
} from "./coordinator-delegation-helpers.js";

const RECEIPT_LOCATION_RE =
  /\/logs\/[^/]+\/[^/]+\/\d+\/entries\/[0-9a-f]{32}\/receipt(?:\?|$)/i;

function toAbsoluteUrl(baseURL: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface ModeCPollCoordinatorOpts {
  coordinatorUrl: string;
  coordinatorToken: string;
  logIdUuid: string;
  privateKeyHex: string;
  signedMaterialKeys: Set<string>;
}

/** Pull-sign all pending KS256 delegation entries (Sealer checkpoint path). */
export async function signPendingModeCKs256Delegations(
  request: APIRequestContext,
  opts: ModeCPollCoordinatorOpts & {
    rootSignerAddress: Uint8Array;
    receiverStats?: ModeCWebhookReceiverStats;
  },
): Promise<{ signed: number; pendingCount: number }> {
  const pending = await request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logIdUuid}/pending-delegation`,
  );
  if (!pending.ok()) {
    throw new Error(
      `GET pending-delegation: ${pending.status()} ${(await pending.text()).slice(0, 300)}`,
    );
  }
  const body = (await pending.json()) as {
    entries: Array<{
      mmrStart: number;
      mmrEnd: number;
      delegatedPublicKey: string;
    }>;
  };
  let signed = 0;
  for (const entry of body.entries) {
    const dedupeKey = `${entry.mmrStart}:${entry.mmrEnd}:${entry.delegatedPublicKey}`;
    if (opts.signedMaterialKeys.has(dedupeKey)) continue;
    const delegatedPublicKey = base64ToBytes(entry.delegatedPublicKey);
    await submitModeCKs256DelegationMaterial({
      coordinatorBaseUrl: opts.coordinatorUrl,
      coordinatorAppToken: opts.coordinatorToken,
      logIdUuid: opts.logIdUuid,
      rootSignerAddress: opts.rootSignerAddress,
      privateKeyHex: opts.privateKeyHex,
      mmrStart: entry.mmrStart,
      mmrEnd: entry.mmrEnd,
      delegatedPublicKey,
    });
    opts.signedMaterialKeys.add(dedupeKey);
    if (opts.receiverStats) opts.receiverStats.materialsSubmitted++;
    signed++;
  }
  return { signed, pendingCount: body.entries.length };
}

/**
 * Advance delegation material during Mode C poll loops.
 * Default: webhook-push only (receiver handles delivery). Pull when
 * E2E_MODE_C_ALLOW_PULL_FALLBACK=1.
 */
export async function advanceModeCDelegationMaterialForPoll(
  request: APIRequestContext,
  opts: ModeCPollCoordinatorOpts & {
    rootSignerAddress: Uint8Array;
    receiverStats?: ModeCWebhookReceiverStats;
  },
): Promise<{ signed: number; pendingCount: number }> {
  if (modeCAllowPullFallback()) {
    return signPendingModeCKs256Delegations(request, opts);
  }
  await sleepMs(500);
  return { signed: 0, pendingCount: 0 };
}

async function pollReceiptUntil200(opts: {
  request: APIRequestContext;
  receiptUrlAbsolute: string;
  receiverStats: ModeCWebhookReceiverStats;
  rootSignerAddress: Uint8Array;
  coordinatorPoll?: ModeCPollCoordinatorOpts & {
    receiverStats?: ModeCWebhookReceiverStats;
  };
  maxWaitMs?: number;
}): Promise<{
  status: number;
  headers: { [key: string]: string };
  body: Uint8Array;
}> {
  const maxWaitMs = opts.maxWaitMs ?? E2E_POLL_MAX_WAIT_MS;
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    if (opts.coordinatorPoll) {
      await advanceModeCDelegationMaterialForPoll(opts.request, {
        ...opts.coordinatorPoll,
        rootSignerAddress: opts.rootSignerAddress,
        receiverStats: opts.receiverStats,
      });
    }
    const res = await opts.request.get(opts.receiptUrlAbsolute, {
      headers: { Accept: "application/cbor" },
    });
    if (res.status() === 200) {
      const body = new Uint8Array(await res.body());
      const cert = extractDelegationCertFromReceipt(body);
      const verified = await verifyKs256BootstrapDelegationCertificate({
        certificate: cert,
        rootSignerAddress: opts.rootSignerAddress,
      });
      if (!verified) {
        throw new Error(
          "receipt delegation cert did not verify against Mode C publicRoot",
        );
      }
      return {
        status: res.status(),
        headers: res.headers(),
        body,
      };
    }
    if (res.status() !== 404) {
      throw new Error(
        `resolve-receipt: expected 200 or retryable 404, got ${res.status()}`,
      );
    }
    const ladderStep =
      sequencingBackoff[Math.min(attempt, sequencingBackoff.length - 1)]!;
    await sleepMs(ladderStep);
    attempt++;
  }
  throw new Error(
    `Mode C webhook seal: receipt not ready within ${maxWaitMs}ms ` +
      `(webhooks=${opts.receiverStats.webhooksReceived}, ` +
      `material=${opts.receiverStats.materialsSubmitted})`,
  );
}

export async function pollRegistrationThroughModeCWebhook(opts: {
  request: APIRequestContext;
  statusUrlAbsolute: string;
  baseURL: string;
  receiverStats: ModeCWebhookReceiverStats;
  rootSignerAddress: Uint8Array;
  coordinatorPoll: ModeCPollCoordinatorOpts;
  maxWaitMs?: number;
}): Promise<{
  receiptUrlAbsolute: string;
  entryIdHex: string;
  receiptRes: {
    status: number;
    headers: { [key: string]: string };
    body: Uint8Array;
  };
}> {
  const maxWaitMs = opts.maxWaitMs ?? E2E_POLL_MAX_WAIT_MS;
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    await advanceModeCDelegationMaterialForPoll(opts.request, {
      ...opts.coordinatorPoll,
      rootSignerAddress: opts.rootSignerAddress,
      receiverStats: opts.receiverStats,
    });
    const res = await opts.request.get(opts.statusUrlAbsolute, {
      maxRedirects: 0,
      headers: { Accept: "application/cbor" },
    });
    if (res.status() !== 303) {
      throw new Error(
        `poll registration status: expected 303, got ${res.status()}`,
      );
    }
    const loc = res.headers()["location"];
    if (!loc) throw new Error("poll registration status: 303 without Location");
    if (RECEIPT_LOCATION_RE.test(loc)) {
      const entryIdHex = loc
        .match(/\/entries\/([0-9a-f]{32})\/receipt/i)![1]!
        .toLowerCase();
      const receiptUrlAbsolute = toAbsoluteUrl(opts.baseURL, loc);
      return {
        receiptUrlAbsolute,
        entryIdHex,
        receiptRes: await pollReceiptUntil200({
          request: opts.request,
          receiptUrlAbsolute,
          receiverStats: opts.receiverStats,
          rootSignerAddress: opts.rootSignerAddress,
          coordinatorPoll: opts.coordinatorPoll,
          maxWaitMs: E2E_POLL_MAX_WAIT_MS,
        }),
      };
    }
    const ladderStep =
      sequencingBackoff[Math.min(attempt, sequencingBackoff.length - 1)]!;
    await sleepMs(ladderStep);
    attempt++;
  }
  throw new Error(
    `Mode C webhook registration did not reach receipt within ${maxWaitMs}ms`,
  );
}

/** Decode KS256 coordinator public-root CBOR `key` field (20-byte address). */
export function decodeCoordinatorKs256PublicRootKey(
  cborBytes: Uint8Array,
): Uint8Array {
  const raw = decode(cborBytes) as Record<string, unknown>;
  const key = raw.key;
  if (!(key instanceof Uint8Array) || key.length !== 20) {
    throw new Error("KS256 public-root response missing 20-byte key");
  }
  return key;
}

/**
 * Wait for webhook-driven material, or submit from coordinator pending when the
 * deployed coordinator cannot reach localhost (no E2E_MODE_C_WEBHOOK_PUBLIC_BASE).
 */
export async function waitForModeCDelegationMaterial(opts: {
  request: APIRequestContext;
  coordinatorUrl: string;
  coordinatorToken: string;
  logIdUuid: string;
  receiverStats: ModeCWebhookReceiverStats;
  rootSignerAddress: Uint8Array;
  privateKeyHex: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  maxWaitMs?: number;
}): Promise<"webhook" | "pull"> {
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const deadline = Date.now() + maxWaitMs;
  while (opts.receiverStats.materialsSubmitted < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (opts.receiverStats.materialsSubmitted > 0) {
    if (opts.receiverStats.webhooksReceived < 1) {
      throw new Error("material submitted without webhook delivery");
    }
    return "webhook";
  }

  if (!modeCAllowPullFallback()) {
    throw new Error(
      "Mode C delegation material not received via webhook push " +
        `(webhooks=${opts.receiverStats.webhooksReceived}, ` +
        `material=${opts.receiverStats.materialsSubmitted}). ` +
        "Set E2E_MODE_C_WEBHOOK_PUBLIC_BASE, ensure cloudflared is installed, " +
        "or set E2E_MODE_C_ALLOW_PULL_FALLBACK=1 for local pull backstop only.",
    );
  }

  const pending = await opts.request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logIdUuid}/pending-delegation`,
  );
  if (!pending.ok()) {
    throw new Error(
      `GET pending-delegation: ${pending.status()} ${(await pending.text()).slice(0, 300)}`,
    );
  }
  const body = (await pending.json()) as {
    entries: Array<{
      mmrStart: number;
      mmrEnd: number;
      delegatedPublicKey: string;
    }>;
  };
  const match = body.entries.find(
    (e) =>
      e.mmrStart === opts.mmrStart &&
      e.mmrEnd === opts.mmrEnd &&
      e.delegatedPublicKey === bytesToBase64(opts.delegatedPublicKey),
  );
  if (!match) {
    throw new Error(
      "Mode C delegation material not submitted via webhook and no matching " +
        "pending entry (set E2E_MODE_C_WEBHOOK_PUBLIC_BASE for push delivery)",
    );
  }
  await submitModeCKs256DelegationMaterial({
    coordinatorBaseUrl: opts.coordinatorUrl,
    coordinatorAppToken: opts.coordinatorToken,
    logIdUuid: opts.logIdUuid,
    rootSignerAddress: opts.rootSignerAddress,
    privateKeyHex: opts.privateKeyHex,
    mmrStart: opts.mmrStart,
    mmrEnd: opts.mmrEnd,
    delegatedPublicKey: opts.delegatedPublicKey,
  });
  opts.receiverStats.materialsSubmitted++;
  return "pull";
}
