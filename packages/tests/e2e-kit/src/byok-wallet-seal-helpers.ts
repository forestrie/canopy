import type { APIRequestContext } from "@playwright/test";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import {
  encodeGrantPayload,
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
  uuidToBytes,
} from "@forestrie/grant-builder";
import type { Grant } from "@forestrie/grant-builder";
import { ensureForestGenesisEs256E2e } from "./forest-genesis-e2e.js";
import {
  es256BootstrapContractAddrBytes,
  univocityGenesisChainId,
} from "./univocity-genesis-e2e.js";
import {
  buildByokDelegationMaterial,
  bytesToBase64,
  exportEs256RootXy,
  verifyByokDelegationCertificate,
} from "./coordinator-delegation-helpers.js";
import {
  E2E_POLL_MAX_WAIT_MS,
  sequencingBackoff,
  sleepMs,
} from "./arithmetic-backoff-poll.js";
import { bytesToForestrieGrantBase64 } from "@forestrie/grant-builder";

const RECEIPT_LOCATION_RE =
  /\/logs\/[^/]+\/[^/]+\/\d+\/entries\/[0-9a-f]{32}\/receipt(?:\?|$)/i;

export interface ByokPollStats {
  pendingEntriesSeen: number;
  materialSigned: number;
}

function cborBytes(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

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

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)),
  );
}

async function signCoseSign1(opts: {
  keyPair: CryptoKeyPair;
  payload: Uint8Array;
  kid?: Uint8Array;
  unprotected?: Map<number, unknown>;
}): Promise<Uint8Array> {
  const protectedMap = new Map<number, unknown>([[1, -7]]);
  if (opts.kid) protectedMap.set(4, opts.kid);
  const protectedBytes = cborBytes(protectedMap);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      opts.keyPair.privateKey,
      toArrayBuffer(
        encodeSigStructure(protectedBytes, new Uint8Array(), opts.payload),
      ),
    ),
  );
  return cborBytes([
    protectedBytes,
    opts.unprotected ?? new Map<number, unknown>(),
    opts.payload,
    signature,
  ]);
}

export async function mintByokBootstrapGrant(opts: {
  request: APIRequestContext;
  rootLogId: string;
  onboardToken: string;
  rootKeyPair: CryptoKeyPair;
}): Promise<{ grantBase64: string; grantData: Uint8Array }> {
  const { x, y } = await exportEs256RootXy(opts.rootKeyPair);
  const grantData = new Uint8Array(64);
  grantData.set(x, 0);
  grantData.set(y, 32);
  await ensureForestGenesisEs256E2e(opts.request, {
    logId: opts.rootLogId,
    onboardToken: opts.onboardToken,
    bootstrapKey: grantData,
    univocityAddr: es256BootstrapContractAddrBytes(),
    chainId: univocityGenesisChainId(),
  });
  const grantBitmap = new Uint8Array(8);
  grantBitmap[3] = 0x03;
  grantBitmap[7] = 0x01;
  const id16 = uuidToBytes(opts.rootLogId);
  const grant: Grant = {
    logId: id16,
    ownerLogId: id16,
    grant: grantBitmap,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
  const grantPayload = encodeGrantPayload(grant);
  const sign1 = await signCoseSign1({
    keyPair: opts.rootKeyPair,
    payload: await sha256(grantPayload),
    kid: x,
    unprotected: new Map<number, unknown>([
      [HEADER_FORESTRIE_GRANT_V0, grantPayload],
      [HEADER_IDTIMESTAMP, new Uint8Array(8)],
    ]),
  });
  return { grantBase64: bytesToForestrieGrantBase64(sign1), grantData };
}

export async function signByokStatement(opts: {
  rootKeyPair: CryptoKeyPair;
  grantData: Uint8Array;
  payload: Uint8Array;
}): Promise<Uint8Array> {
  return signCoseSign1({
    keyPair: opts.rootKeyPair,
    kid: opts.grantData.subarray(0, 32),
    payload: opts.payload,
  });
}

export async function signPendingDelegations(opts: {
  request: APIRequestContext;
  coordinatorUrl: string;
  coordinatorToken: string;
  logId: string;
  logIdHex32: string;
  rootKeyPair: CryptoKeyPair;
  signedMaterialKeys: Set<string>;
  stats?: ByokPollStats;
}): Promise<{ signed: number; pendingCount: number }> {
  const pending = await opts.request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/pending-delegation`,
  );
  if (!pending.ok()) {
    throw new Error(
      `GET pending-delegation: ${pending.status()} ${(await pending.text()).slice(0, 300)}`,
    );
  }
  const body = (await pending.json()) as {
    entries: Array<{
      mmrStart?: number;
      mmrEnd?: number;
      delegatedPublicKey: string;
    }>;
  };
  // The coordinator appends a window-less standing delegate-key entry (C3,
  // delegation-in-advance) to pending-delegation once a live standing key
  // exists. This BYOK helper signs only windowed on-demand material, and
  // sealer-liveness detection keys on windowed entries actually appearing —
  // so filter the standing entry out. It has no mmrStart/mmrEnd (signing it
  // would CBOR-encode undefined bounds), and being always-present it would
  // otherwise defeat the "no pending entries" liveness timeout.
  const windowed = body.entries.filter(
    (
      e,
    ): e is { mmrStart: number; mmrEnd: number; delegatedPublicKey: string } =>
      typeof e.mmrStart === "number" && typeof e.mmrEnd === "number",
  );
  if (opts.stats && windowed.length > 0) {
    opts.stats.pendingEntriesSeen += windowed.length;
  }
  let signed = 0;
  for (const entry of windowed) {
    const key = `${entry.mmrStart}:${entry.mmrEnd}:${entry.delegatedPublicKey}`;
    if (opts.signedMaterialKeys.has(key)) continue;
    const delegatedPublicKey = base64ToBytes(entry.delegatedPublicKey);
    const material = await buildByokDelegationMaterial({
      rootKeyPair: opts.rootKeyPair,
      logIdHex32: opts.logIdHex32,
      mmrStart: entry.mmrStart,
      mmrEnd: entry.mmrEnd,
      delegatedPublicKey,
    });
    const verified = await verifyByokDelegationCertificate({
      certificate: material.certificate,
      rootPublicKey: opts.rootKeyPair.publicKey,
    });
    if (!verified) {
      throw new Error(
        "runner-built BYOK delegation certificate did not verify",
      );
    }
    const res = await opts.request.post(
      `${opts.coordinatorUrl}/api/delegations/certificate`,
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
          ...(material.onchainSignature
            ? { onchainSignature: bytesToBase64(material.onchainSignature) }
            : {}),
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
  return { signed, pendingCount: windowed.length };
}

export async function pollRegistrationThroughByokReceipt(opts: {
  request: APIRequestContext;
  statusUrlAbsolute: string;
  baseURL: string;
  coordinatorUrl: string;
  coordinatorToken: string;
  logId: string;
  logIdHex32: string;
  rootKeyPair: CryptoKeyPair;
  signedMaterialKeys: Set<string>;
  stats?: ByokPollStats;
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
  let lastPendingSeenAt = start;
  while (Date.now() - start < maxWaitMs) {
    const { pendingCount } = await signPendingDelegations(opts);
    if (pendingCount > 0) lastPendingSeenAt = Date.now();
    if (
      Date.now() - lastPendingSeenAt >= E2E_POLL_MAX_WAIT_MS &&
      (opts.stats?.materialSigned ?? 0) === 0
    ) {
      throw new Error(
        `BYOK: no coordinator pending entries for ${E2E_POLL_MAX_WAIT_MS}ms ` +
          "(Sealer may not be issuing). Check sealer queue and R2 notifications.",
      );
    }
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
    if (!loc) throw new Error("poll registration status: 303 without Location");
    if (RECEIPT_LOCATION_RE.test(loc)) {
      const entryIdHex = loc
        .match(/\/entries\/([0-9a-f]{32})\/receipt/i)![1]!
        .toLowerCase();
      const receiptUrlAbsolute = toAbsoluteUrl(opts.baseURL, loc);
      return {
        receiptUrlAbsolute,
        entryIdHex,
        receiptRes: await pollByokResolveReceiptUntil200({
          ...opts,
          receiptUrlAbsolute,
          maxWaitMs: E2E_POLL_MAX_WAIT_MS,
        }),
      };
    }
    const ladderStep =
      sequencingBackoff[Math.min(attempt, sequencingBackoff.length - 1)]!;
    await sleepMs(ladderStep);
    attempt++;
  }
  throw formatByokPollTimeout(
    `BYOK registration did not reach receipt redirect within ${maxWaitMs}ms`,
    opts.stats,
  );
}

async function pollByokResolveReceiptUntil200(opts: {
  request: APIRequestContext;
  receiptUrlAbsolute: string;
  coordinatorUrl: string;
  coordinatorToken: string;
  logId: string;
  logIdHex32: string;
  rootKeyPair: CryptoKeyPair;
  signedMaterialKeys: Set<string>;
  stats?: ByokPollStats;
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
    await signPendingDelegations(opts);
    const res = await opts.request.get(opts.receiptUrlAbsolute, {
      headers: { Accept: "application/cbor" },
    });
    if (res.status() === 200) {
      return {
        status: res.status(),
        headers: res.headers(),
        body: new Uint8Array(await res.body()),
      };
    }
    if (res.status() !== 404) {
      throw new Error(
        `resolve-receipt: expected 200 or retryable 404, got ${res.status()} for ${opts.receiptUrlAbsolute}`,
      );
    }
    const ladderStep =
      sequencingBackoff[Math.min(attempt, sequencingBackoff.length - 1)]!;
    await sleepMs(ladderStep);
    attempt++;
  }
  throw formatByokPollTimeout(
    `resolve-receipt: 404 until timeout ${maxWaitMs}ms (${opts.receiptUrlAbsolute})`,
    opts.stats,
  );
}

function formatByokPollTimeout(message: string, stats?: ByokPollStats): Error {
  const pending = stats?.pendingEntriesSeen ?? 0;
  const signed = stats?.materialSigned ?? 0;
  let hint =
    " BYOK delegation material may still be pending or Sealer may still be sealing.";
  if (signed > 0 && pending === 0) {
    hint +=
      " Material was submitted but pending is empty: check Sealer logs for " +
      "verify delegation lease errors (poison cert / wrong CBOR).";
  } else if (pending === 0) {
    hint += " No pending entries were observed during the poll.";
  }
  return new Error(message + hint);
}

export function extractDelegationCertFromReceipt(
  receiptBytes: Uint8Array,
): Uint8Array {
  const raw = decodeCborDeterministic(receiptBytes) as unknown[];
  if (!Array.isArray(raw) || raw.length !== 4) {
    throw new Error("receipt must be COSE_Sign1 array");
  }
  const unprotected = raw[1];
  const cert =
    unprotected instanceof Map
      ? unprotected.get(1000)
      : (unprotected as Record<string, unknown>)["1000"];
  if (!(cert instanceof Uint8Array) || cert.length === 0) {
    throw new Error("receipt missing delegation cert label 1000");
  }
  return cert;
}
