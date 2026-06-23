/**
 * In-repo Mode C webhook receiver for stretch e2e (plan-0037).
 * Verifies coordinator webhook signatures, signs KS256 material, POSTs to coordinator.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  buildKs256BootstrapDelegationMaterial,
  bytesToBase64,
} from "../../utils/coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "../../utils/forestrie-hex-id.js";

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
   * When set, advertised webhook URL uses this base instead of
   * `http://127.0.0.1:{port}` (tunnel / public ingress for deployed coordinator).
   */
  publicWebhookBaseUrl?: string;
}

export interface ModeCWebhookReceiverStats {
  webhooksReceived: number;
  materialsSubmitted: number;
  requestKeysSeen: Set<string>;
}

export interface ModeCWebhookReceiver {
  webhookUrl: string;
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
  };

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
          logIdUuid: config.logIdUuid,
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
  const localBase = `http://localhost:${addr.port}`;
  const webhookUrl = `${config.publicWebhookBaseUrl?.replace(/\/$/, "") ?? localBase}/webhook`;

  return {
    webhookUrl,
    stats,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
