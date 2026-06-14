/**
 * Coordinator delegation loop for contract-bootstrap root logs (Option A).
 * Mirrors BYOK `signPendingDelegations` but signs with provision bootstrap keys.
 */

import type { APIRequestContext } from "@playwright/test";
import { assertCoordinatorApiE2eEnv } from "./coordinator-api-env.js";
import {
  buildByokDelegationMaterial,
  buildKs256BootstrapDelegationMaterial,
  bytesToBase64,
  exportEs256RootXy,
  importEs256PemKeyPair,
  uploadBootstrapKs256PublicRoot,
  uploadByokRootPublicKey,
  verifyByokDelegationCertificate,
  verifyKs256BootstrapDelegationCertificate,
} from "./coordinator-delegation-helpers.js";
import {
  E2E_POLL_MAX_WAIT_MS,
  sequencingBackoff,
  sleepMs,
} from "./arithmetic-backoff-poll.js";
import type { ByokPollStats } from "./byok-wallet-seal-helpers.js";
import type { E2eBootstrapVariant } from "./e2e-bootstrap-variant.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";
import {
  bootstrapKs256PrivateKeyHex,
  ks256AddressFromPrivateKeyHex,
} from "./ks256-wallet-grant.js";
import { bootstrapEs256PrivateKeyPem } from "./mint-es256-root-grant-e2e.js";

const RECEIPT_LOCATION_RE =
  /\/logs\/[^/]+\/[^/]+\/\d+\/entries\/[0-9a-f]{32}\/receipt(?:\?|$)/i;

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function toAbsoluteUrl(baseURL: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}

function formatBootstrapPollTimeout(
  message: string,
  stats?: ByokPollStats,
): Error {
  const pending = stats?.pendingEntriesSeen ?? 0;
  const signed = stats?.materialSigned ?? 0;
  let hint =
    " Bootstrap delegation material may still be pending or Sealer may still be sealing.";
  if (signed > 0 && pending === 0) {
    hint +=
      " Material was submitted but pending is empty: check Sealer logs for " +
      "verify delegation lease errors (poison cert / wrong CBOR).";
  } else if (pending === 0) {
    hint += " No pending entries were observed during the poll.";
  }
  return new Error(message + hint);
}

export interface BootstrapSigningContext {
  variant: E2eBootstrapVariant;
  es256RootKeyPair?: CryptoKeyPair;
  ks256PrivateKeyHex?: string;
  ks256RootAddress?: Uint8Array;
}

async function loadBootstrapSigningContext(
  variant: E2eBootstrapVariant,
): Promise<BootstrapSigningContext> {
  if (variant.id === "es256") {
    const pem = bootstrapEs256PrivateKeyPem();
    if (!pem) {
      throw new Error(
        "E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE is required for ES256 bootstrap delegation",
      );
    }
    const boot = await variant.fetchBootstrapKey();
    if (boot.key.length !== 64) {
      throw new Error("ES256 bootstrap key must be 64-byte x‖y");
    }
    const rootKeyPair = await importEs256PemKeyPair(pem);
    const { x, y } = await exportEs256RootXy(rootKeyPair);
    if (
      !bytesEqual(x, boot.key.slice(0, 32)) ||
      !bytesEqual(y, boot.key.slice(32, 64))
    ) {
      throw new Error(
        "ES256 bootstrap PEM public key does not match on-chain bootstrapConfig()",
      );
    }
    return { variant, es256RootKeyPair: rootKeyPair };
  }

  const privateKeyHex = bootstrapKs256PrivateKeyHex();
  if (!privateKeyHex) {
    throw new Error(
      "E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE is required for KS256 bootstrap delegation",
    );
  }
  const boot = await variant.fetchBootstrapKey();
  if (boot.key.length !== 20) {
    throw new Error("KS256 bootstrap key must be 20-byte address");
  }
  const rootAddress = ks256AddressFromPrivateKeyHex(privateKeyHex);
  if (!bytesEqual(rootAddress, boot.key)) {
    throw new Error(
      "KS256 bootstrap wallet address does not match on-chain bootstrapConfig()",
    );
  }
  return {
    variant,
    ks256PrivateKeyHex: privateKeyHex,
    ks256RootAddress: rootAddress,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** POST signing-route wallet + optional coordinator public-root for bootstrap key. */
export async function setupBootstrapCoordinatorDelegation(opts: {
  request: APIRequestContext;
  logId: string;
  variant: E2eBootstrapVariant;
}): Promise<BootstrapSigningContext> {
  const coordinator = assertCoordinatorApiE2eEnv();
  const signingContext = await loadBootstrapSigningContext(opts.variant);

  const signingRoute = await opts.request.post(
    `${coordinator.baseUrl}/api/logs/${opts.logId}/signing-route`,
    {
      headers: {
        Authorization: `Bearer ${coordinator.appToken}`,
        "Content-Type": "application/json",
      },
      data: { mode: "wallet" },
    },
  );
  if (!signingRoute.ok()) {
    throw new Error(
      `POST signing-route: ${signingRoute.status()} ${(await signingRoute.text()).slice(0, 300)}`,
    );
  }

  if (signingContext.es256RootKeyPair) {
    const { x, y } = await exportEs256RootXy(signingContext.es256RootKeyPair);
    const publicRoot = await uploadByokRootPublicKey({
      coordinatorUrl: coordinator.baseUrl,
      token: coordinator.appToken,
      logId: opts.logId,
      x,
      y,
    });
    if (!publicRoot.ok) {
      throw new Error(
        `POST public-root (ES256): ${publicRoot.status} ${(await publicRoot.text()).slice(0, 300)}`,
      );
    }
  } else if (signingContext.ks256RootAddress) {
    const publicRoot = await uploadBootstrapKs256PublicRoot({
      coordinatorUrl: coordinator.baseUrl,
      token: coordinator.appToken,
      logId: opts.logId,
      address: signingContext.ks256RootAddress,
    });
    if (!publicRoot.ok) {
      throw new Error(
        `POST public-root (KS256): ${publicRoot.status} ${(await publicRoot.text()).slice(0, 300)}`,
      );
    }
  }

  return signingContext;
}

export async function signPendingBootstrapDelegations(opts: {
  request: APIRequestContext;
  coordinatorUrl: string;
  coordinatorToken: string;
  logId: string;
  logIdHex32: string;
  signingContext: BootstrapSigningContext;
  signedMaterialKeys: Set<string>;
  stats?: ByokPollStats;
}): Promise<{ signed: number; pendingCount: number }> {
  const pending = await opts.request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/pending-delegation`,
    {
      headers: { Authorization: `Bearer ${opts.coordinatorToken}` },
    },
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
  if (opts.stats && body.entries.length > 0) {
    opts.stats.pendingEntriesSeen += body.entries.length;
  }

  let signed = 0;
  for (const entry of body.entries) {
    const key = `${entry.mmrStart}:${entry.mmrEnd}:${entry.delegatedPublicKey}`;
    if (opts.signedMaterialKeys.has(key)) continue;
    const delegatedPublicKey = base64ToBytes(entry.delegatedPublicKey);

    let material: {
      certificate: Uint8Array;
      issuedAt: number;
      expiresAt: number;
    };
    if (opts.signingContext.es256RootKeyPair) {
      material = await buildByokDelegationMaterial({
        rootKeyPair: opts.signingContext.es256RootKeyPair,
        logIdHex32: opts.logIdHex32,
        mmrStart: entry.mmrStart,
        mmrEnd: entry.mmrEnd,
        delegatedPublicKey,
      });
      const verified = await verifyByokDelegationCertificate({
        certificate: material.certificate,
        rootPublicKey: opts.signingContext.es256RootKeyPair.publicKey,
      });
      if (!verified) {
        throw new Error(
          "runner-built ES256 bootstrap delegation certificate did not verify",
        );
      }
    } else {
      const privateKeyHex = opts.signingContext.ks256PrivateKeyHex!;
      const rootAddress = opts.signingContext.ks256RootAddress!;
      material = await buildKs256BootstrapDelegationMaterial({
        rootSignerAddress: rootAddress,
        privateKeyHex,
        logIdHex32: opts.logIdHex32,
        mmrStart: entry.mmrStart,
        mmrEnd: entry.mmrEnd,
        delegatedPublicKey,
      });
      const verified = verifyKs256BootstrapDelegationCertificate({
        certificate: material.certificate,
        rootSignerAddress: rootAddress,
      });
      if (!verified) {
        throw new Error(
          "runner-built KS256 bootstrap delegation certificate did not verify",
        );
      }
    }

    const res = await opts.request.post(
      `${opts.coordinatorUrl}/api/delegations/material`,
      {
        headers: {
          Authorization: `Bearer ${opts.coordinatorToken}`,
          "Content-Type": "application/json",
        },
        data: {
          logId: opts.logId,
          mmrStart: entry.mmrStart,
          mmrEnd: entry.mmrEnd,
          delegatedPublicKey: bytesToBase64(delegatedPublicKey),
          certificate: bytesToBase64(material.certificate),
          issuedAt: material.issuedAt,
          expiresAt: material.expiresAt,
        },
      },
    );
    if (!res.ok()) {
      throw new Error(
        `POST delegation material: ${res.status()} ${(await res.text()).slice(0, 300)}`,
      );
    }
    opts.signedMaterialKeys.add(key);
    signed++;
    if (opts.stats) opts.stats.materialSigned++;
  }
  return { signed, pendingCount: body.entries.length };
}

/** Combined status + receipt poll budget (sealer delegation can lag massif commit). */
export const BOOTSTRAP_RECEIPT_POLL_MAX_WAIT_MS = E2E_POLL_MAX_WAIT_MS * 3;

export async function pollBootstrapRegistrationThroughReceipt(opts: {
  request: APIRequestContext;
  statusUrlAbsolute: string;
  baseURL: string;
  logId: string;
  signingContext: BootstrapSigningContext;
  signedMaterialKeys: Set<string>;
  stats?: ByokPollStats;
  ladderMs?: number[];
  maxWaitMs?: number;
  resolveReceiptMaxMs?: number;
}): Promise<{
  receiptUrlAbsolute: string;
  entryIdHex: string;
  receiptRes: {
    status: number;
    headers: { [key: string]: string };
    body: Uint8Array;
  };
}> {
  const coordinator = assertCoordinatorApiE2eEnv();
  const ladder = opts.ladderMs ?? sequencingBackoff;
  const logIdHex32 = normalizeForestrieHexId32(opts.logId);
  const maxWaitMs =
    opts.resolveReceiptMaxMs ??
    opts.maxWaitMs ??
    BOOTSTRAP_RECEIPT_POLL_MAX_WAIT_MS;
  const deadlineMs = Date.now() + maxWaitMs;
  let attempt = 0;
  let receiptUrlAbsolute: string | undefined;
  let entryIdHex: string | undefined;

  while (Date.now() < deadlineMs) {
    await signPendingBootstrapDelegations({
      request: opts.request,
      coordinatorUrl: coordinator.baseUrl,
      coordinatorToken: coordinator.appToken,
      logId: opts.logId,
      logIdHex32,
      signingContext: opts.signingContext,
      signedMaterialKeys: opts.signedMaterialKeys,
      stats: opts.stats,
    });

    if (receiptUrlAbsolute) {
      const res = await opts.request.get(receiptUrlAbsolute, {
        headers: { Accept: "application/cbor" },
      });
      if (res.status() === 200) {
        return {
          receiptUrlAbsolute,
          entryIdHex: entryIdHex!,
          receiptRes: {
            status: res.status(),
            headers: res.headers(),
            body: new Uint8Array(await res.body()),
          },
        };
      }
      if (res.status() !== 404) {
        throw new Error(
          `resolve-receipt: expected 200 or retryable 404, got ${res.status()} for ${receiptUrlAbsolute}`,
        );
      }
    } else {
      const res = await opts.request.get(opts.statusUrlAbsolute, {
        maxRedirects: 0,
        headers: { Accept: "application/cbor" },
      });
      if (res.status() !== 303) {
        throw new Error(
          `poll registration status: expected 303, got ${res.status()} for ${opts.statusUrlAbsolute}`,
        );
      }
      const loc = res.headers()["location"];
      if (!loc) {
        throw new Error("poll registration status: 303 without Location");
      }
      if (RECEIPT_LOCATION_RE.test(loc)) {
        entryIdHex = loc
          .match(/\/entries\/([0-9a-f]{32})\/receipt/i)![1]!
          .toLowerCase();
        receiptUrlAbsolute = toAbsoluteUrl(opts.baseURL, loc);
      }
    }

    const ladderStep = ladder[Math.min(attempt, ladder.length - 1)]!;
    await sleepMs(ladderStep);
    attempt++;
  }

  if (receiptUrlAbsolute) {
    throw formatBootstrapPollTimeout(
      `resolve-receipt: 404 until deadline ${maxWaitMs}ms (${receiptUrlAbsolute})`,
      opts.stats,
    );
  }
  throw formatBootstrapPollTimeout(
    `Bootstrap registration did not reach receipt redirect within ${maxWaitMs}ms`,
    opts.stats,
  );
}
