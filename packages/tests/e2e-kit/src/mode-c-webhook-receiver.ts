/**
 * In-repo Mode C webhook receiver for system e2e (plan-0037 / FOR-126).
 * Verifies coordinator webhook signatures, signs KS256 material, POSTs to coordinator.
 *
 * Reference receiver semantics — three independent checks, all required:
 *
 * 1. **Source auth** — ES256 signature over `{timestamp}.{body}`, verified
 *    against the coordinator's JWKS (ADR-0006).
 * 2. **Ownership** — the event's `logId` must be a log this receiver owns
 *    (ADR-0005 amendment, FOR-468). An instance-level webhook serves every log
 *    of an instance from one endpoint, so a valid signature is not authority to
 *    sign for whatever log the event names.
 * 3. **Idempotency** — dedup on `requestKey`; delivery is at-least-once by
 *    design (ADR-0005 B+C).
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  buildKs256BootstrapDelegationMaterial,
  bytesToBase64,
} from "./coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";

export interface DelegationRequiredEvent {
  requestKey: string;
  type: "delegation.required";
  version: 1;
  logId: string;
  authLogId: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: string;
  requestedAt: number;
  certificateSubmitUrl: string;
  /** @deprecated use certificateSubmitUrl */
  materialSubmitUrl?: string;
}

export interface ModeCWebhookReceiverConfig {
  coordinatorBaseUrl: string;
  coordinatorAppToken: string;
  rootSignerAddress: Uint8Array;
  privateKeyHex: string;
  /** Log UUID for material POST body `logId` (coordinator accepts dashed form). */
  logIdUuid: string;
  /**
   * Every log this receiver is willing to sign for; defaults to
   * `[logIdUuid]`.
   *
   * An instance-level webhook points many logs at one endpoint (ADR-0005
   * amendment, FOR-468), so the endpoint must decide which of them it owns
   * rather than signing whatever arrives. The blast radius is bounded — it can
   * only sign with keys it holds — but "I hold this key" and "I should sign for
   * this log now" are different assertions.
   */
  ownedLogIdUuids?: string[];
  /**
   * When set, advertised webhook URL uses this base instead of
   * `http://127.0.0.1:{port}` (tunnel / public ingress for deployed coordinator).
   */
  publicWebhookBaseUrl?: string;
}

export interface ModeCWebhookReceiverStats {
  webhooksReceived: number;
  materialsSubmitted: number;
  requestKeysSeen: Set<string>;
  /** Events refused because their `logId` is not a log this receiver owns. */
  foreignLogIdsRejected: number;
}

export interface ModeCWebhookReceiver {
  webhookUrl: string;
  /** Local TCP port bound on 127.0.0.1 (for cloudflared tunnel). */
  localPort: number;
  stats: ModeCWebhookReceiverStats;
  close(): Promise<void>;
}

export interface SubmitModeCKs256MaterialInput {
  coordinatorBaseUrl: string;
  coordinatorAppToken: string;
  logIdUuid: string;
  rootSignerAddress: Uint8Array;
  privateKeyHex: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  certificateSubmitUrl?: string;
  /** @deprecated use certificateSubmitUrl */
  materialSubmitUrl?: string;
}

/**
 * Index the logs a receiver owns by the normalized id an event carries.
 *
 * @param logIdUuids - Log ids this endpoint holds signing authority for.
 * @returns Map from normalized 32-hex id to the caller's original form.
 */
export function buildOwnedLogIndex(logIdUuids: string[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const uuid of logIdUuids) {
    index.set(normalizeForestrieHexId32(uuid), uuid);
  }
  return index;
}

/**
 * Resolve an event's `logId` to a log this receiver owns.
 *
 * A valid coordinator signature says the event is genuine, not that this
 * endpoint should sign for the log it names — an instance-level webhook points
 * many logs at one endpoint (ADR-0005 amendment, FOR-468).
 *
 * @param ownedLogs - Index from {@link buildOwnedLogIndex}.
 * @param eventLogId - `logId` off the `delegation.required` event.
 * @returns The owned log id to sign for, or `undefined` to refuse.
 */
export function resolveOwnedLogId(
  ownedLogs: Map<string, string>,
  eventLogId: string,
): string | undefined {
  try {
    return ownedLogs.get(normalizeForestrieHexId32(eventLogId));
  } catch {
    return undefined;
  }
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function fetchWebhookVerifyKey(
  coordinatorBaseUrl: string,
): Promise<CryptoKey> {
  const base = coordinatorBaseUrl.trim().replace(/\/$/, "");
  const res = await fetch(`${base}/.well-known/forestrie-webhook-jwks.json`);
  if (!res.ok) {
    throw new Error(`JWKS fetch failed: ${res.status}`);
  }
  const { keys } = (await res.json()) as {
    keys: Array<JsonWebKey & { kid: string; alg: string }>;
  };
  const publicKeyJwk = keys[0];
  if (!publicKeyJwk) {
    throw new Error("JWKS missing keys");
  }
  return crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

async function verifyWebhookSignature(
  verifyKey: CryptoKey,
  timestamp: string,
  rawBody: string,
  signatureB64Url: string,
): Promise<boolean> {
  const sigBytes = Uint8Array.from(
    atob(signatureB64Url.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    sigBytes,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
}

/** Sign KS256 material and POST to coordinator (shared by webhook + pull fallback). */
export async function submitModeCKs256DelegationMaterial(
  input: SubmitModeCKs256MaterialInput,
): Promise<void> {
  const logIdHex32 = normalizeForestrieHexId32(input.logIdUuid);
  const material = await buildKs256BootstrapDelegationMaterial({
    rootSignerAddress: input.rootSignerAddress,
    privateKeyHex: input.privateKeyHex,
    logIdHex32,
    mmrStart: input.mmrStart,
    mmrEnd: input.mmrEnd,
    delegatedPublicKey: input.delegatedPublicKey,
  });
  const base = input.coordinatorBaseUrl.trim().replace(/\/$/, "");
  const certificateSubmitUrl =
    input.certificateSubmitUrl ??
    input.materialSubmitUrl ??
    `${base}/api/delegations/certificate`;
  const materialRes = await fetch(certificateSubmitUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.coordinatorAppToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      logId: input.logIdUuid,
      mmrStart: input.mmrStart,
      mmrEnd: input.mmrEnd,
      delegatedPublicKey: bytesToBase64(input.delegatedPublicKey),
      certificate: bytesToBase64(material.certificate),
      issuedAt: material.issuedAt,
      expiresAt: material.expiresAt,
      ...(material.onchainSignature
        ? { onchainSignature: bytesToBase64(material.onchainSignature) }
        : {}),
    }),
  });
  if (!materialRes.ok) {
    const preview = (await materialRes.text()).slice(0, 300);
    throw new Error(
      `POST delegation material: ${materialRes.status} ${preview}`,
    );
  }
}

export async function startModeCWebhookReceiver(
  config: ModeCWebhookReceiverConfig,
): Promise<ModeCWebhookReceiver> {
  if (config.rootSignerAddress.length !== 20) {
    throw new Error("rootSignerAddress must be 20 bytes");
  }

  const verifyKey = await fetchWebhookVerifyKey(config.coordinatorBaseUrl);
  const stats: ModeCWebhookReceiverStats = {
    webhooksReceived: 0,
    materialsSubmitted: 0,
    requestKeysSeen: new Set<string>(),
    foreignLogIdsRejected: 0,
  };

  // The set of logs this endpoint will sign for. Checked on every event in
  // addition to the JWKS signature and the requestKey dedup, never instead of
  // them.
  const ownedLogs = buildOwnedLogIndex(
    config.ownedLogIdUuids ?? [config.logIdUuid],
  );

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "POST" || req.url !== "/webhook") {
          res.writeHead(404);
          res.end();
          return;
        }

        const rawBody = await readRequestBody(req);
        const timestamp = String(
          req.headers["x-forestrie-webhook-timestamp"] ?? "",
        );
        const signature = String(
          req.headers["x-forestrie-webhook-signature"] ?? "",
        );
        if (!timestamp || !signature) {
          res.writeHead(401);
          res.end("missing webhook signature headers");
          return;
        }

        const valid = await verifyWebhookSignature(
          verifyKey,
          timestamp,
          rawBody,
          signature,
        );
        if (!valid) {
          res.writeHead(401);
          res.end("invalid webhook signature");
          return;
        }

        stats.webhooksReceived++;
        const event = JSON.parse(rawBody) as DelegationRequiredEvent;
        if (event.type !== "delegation.required") {
          res.writeHead(400);
          res.end("unexpected event type");
          return;
        }

        // A signature proves the coordinator sent this; it does not say the
        // event is about a log we are entitled to sign for. With an
        // instance-level webhook one endpoint is asked about many logs, so
        // check ownership before signing anything.
        const ownedLogIdUuid = resolveOwnedLogId(ownedLogs, event.logId);
        if (!ownedLogIdUuid) {
          stats.foreignLogIdsRejected++;
          res.writeHead(403);
          res.end("logId is not owned by this receiver");
          return;
        }

        if (stats.requestKeysSeen.has(event.requestKey)) {
          res.writeHead(200);
          res.end("duplicate");
          return;
        }
        stats.requestKeysSeen.add(event.requestKey);

        const delegatedPublicKey = base64ToBytes(event.delegatedPublicKey);
        await submitModeCKs256DelegationMaterial({
          coordinatorBaseUrl: config.coordinatorBaseUrl,
          coordinatorAppToken: config.coordinatorAppToken,
          logIdUuid: ownedLogIdUuid,
          rootSignerAddress: config.rootSignerAddress,
          privateKeyHex: config.privateKeyHex,
          mmrStart: event.mmrStart,
          mmrEnd: event.mmrEnd,
          delegatedPublicKey,
          certificateSubmitUrl:
            event.certificateSubmitUrl ?? event.materialSubmitUrl,
        });
        stats.materialsSubmitted++;

        res.writeHead(200);
        res.end("ok");
      } catch (error) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind Mode C webhook receiver");
  }
  const localBase = `http://127.0.0.1:${addr.port}`;
  const webhookUrl = `${config.publicWebhookBaseUrl?.replace(/\/$/, "") ?? localBase}/webhook`;

  return {
    webhookUrl,
    localPort: addr.port,
    stats,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
