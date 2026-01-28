/**
 * x402-settlement worker
 *
 * Consumes settlement jobs from a Cloudflare Queue and processes them via
 * the X402SettlementDO Durable Object. Each job represents a charge to be
 * settled against an x402 authorization.
 *
 * See: devdocs/arc/arc-0015-x402-settlement-architecture.md
 */

import type { SettlementJob } from "@canopy/x402-settlement-types";
import { hashLogId } from "@canopy/forestrie-sharding";
import { X402SettlementDO } from "./durableobjects/x402settlement.js";
import type { Env } from "./env.js";

export { X402SettlementDO };

/**
 * Resolve the DO shard name for an authId.
 *
 * Uses djb2 hash (same as forestrie-sharding) for consistent distribution.
 */
function resolveShardId(authId: string, shardCount: number): string {
  const hash = hashLogId(authId);
  const index = hash % shardCount;
  return `shard-${index}`;
}

export default {
  /**
   * Queue consumer handler.
   *
   * Processes settlement jobs from the queue, routing each to the appropriate
   * DO shard for idempotent processing.
   */
  async queue(
    batch: MessageBatch<SettlementJob>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const shardCount = parseInt(env.DO_SHARD_COUNT, 10) || 4;

    for (const message of batch.messages) {
      const job = message.body;

      // Validate job structure
      if (!job.authId || !job.idempotencyKey) {
        console.error("Invalid settlement job, missing required fields", {
          jobId: job.jobId,
        });
        message.ack(); // Don't retry invalid messages
        continue;
      }

      // Route to appropriate DO shard
      const shardId = resolveShardId(job.authId, shardCount);
      const doId = env.X402_SETTLEMENT_DO.idFromName(shardId);
      const stub = env.X402_SETTLEMENT_DO.get(doId);

      try {
        const result = await stub.processJob(job);

        if (result.ok) {
          console.log("Settlement succeeded", {
            jobId: job.jobId,
            txHash: result.txHash,
          });
          message.ack();
        } else if (result.permanent) {
          // Permanent error - don't retry, let it go to DLQ
          console.error("Settlement failed permanently", {
            jobId: job.jobId,
            error: result.error,
          });
          message.ack();
        } else {
          // Transient error - retry via queue
          console.warn("Settlement failed transiently, will retry", {
            jobId: job.jobId,
            error: result.error,
          });
          message.retry();
        }
      } catch (err) {
        // Unexpected error in DO - retry
        console.error("Settlement DO error", {
          jobId: job.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
        message.retry();
      }
    }
  },

  /**
   * HTTP handler for health checks and x402 facilitator endpoints.
   *
   * This worker acts as a facilitator for canopy-api, proxying verify/settle
   * requests to the upstream CDP x402 API with our credentials.
   */
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          canopyId: env.CANOPY_ID,
          env: env.NODE_ENV,
          hasCdpCredentials: !!(env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET),
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // x402 facilitator /verify endpoint
    if (url.pathname === "/verify" && request.method === "POST") {
      return handleVerify(request, env);
    }

    // x402 facilitator /settle endpoint
    if (url.pathname === "/settle" && request.method === "POST") {
      return handleSettle(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * Proxy /verify requests to upstream CDP x402 API.
 */
async function handleVerify(request: Request, env: Env): Promise<Response> {
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    console.error("CDP credentials not configured");
    return Response.json(
      { isValid: false, invalidReason: "facilitator not configured" },
      { status: 500 },
    );
  }

  const body = await request.text();

  // Log the full body for debugging schema issues
  console.log("x402-settlement /verify proxy", {
    upstreamUrl: `${env.X402_FACILITATOR_URL}/verify`,
    bodyLength: body.length,
    bodyPreview: body.slice(0, 1000),
  });

  try {
    const jwt = await generateCdpJwt(
      env.CDP_API_KEY_ID,
      env.CDP_API_KEY_SECRET,
      `POST ${new URL(env.X402_FACILITATOR_URL).host}/platform/v2/x402/verify`,
    );

    const res = await fetch(`${env.X402_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body,
    });

    const responseText = await res.text();
    console.log("CDP /verify response", {
      status: res.status,
      body: responseText.slice(0, 500),
    });

    return new Response(responseText, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("CDP /verify error", err);
    return Response.json(
      {
        isValid: false,
        invalidReason: `upstream error: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

/**
 * Proxy /settle requests to upstream CDP x402 API.
 */
async function handleSettle(request: Request, env: Env): Promise<Response> {
  if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) {
    console.error("CDP credentials not configured");
    return Response.json(
      { success: false, error: "facilitator not configured" },
      { status: 500 },
    );
  }

  const body = await request.text();

  console.log("x402-settlement /settle proxy", {
    upstreamUrl: `${env.X402_FACILITATOR_URL}/settle`,
    bodyLength: body.length,
  });

  try {
    const jwt = await generateCdpJwt(
      env.CDP_API_KEY_ID,
      env.CDP_API_KEY_SECRET,
      `POST ${new URL(env.X402_FACILITATOR_URL).host}/platform/v2/x402/settle`,
    );

    const res = await fetch(`${env.X402_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body,
    });

    const responseText = await res.text();
    console.log("CDP /settle response", {
      status: res.status,
      body: responseText.slice(0, 500),
    });

    return new Response(responseText, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("CDP /settle error", err);
    return Response.json(
      {
        success: false,
        error: `upstream error: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}

/**
 * Generate a CDP API JWT for authentication.
 *
 * CDP uses ES256 (ECDSA with P-256 and SHA-256).
 */
async function generateCdpJwt(
  keyId: string,
  keySecret: string,
  uri: string,
): Promise<string> {
  const header = {
    alg: "ES256",
    kid: keyId,
    typ: "JWT",
    nonce: crypto.randomUUID(),
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: keyId,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri,
  };

  const base64UrlEncode = (data: Uint8Array): string =>
    btoa(String.fromCharCode(...data))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const jsonToBase64Url = (obj: unknown): string =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));

  const headerB64 = jsonToBase64Url(header);
  const payloadB64 = jsonToBase64Url(payload);
  const message = `${headerB64}.${payloadB64}`;

  // Import the PEM key and sign
  const privateKey = await importPemKey(keySecret);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message),
  );

  // Convert signature from DER to raw r||s format if needed
  // SubtleCrypto ECDSA returns raw r||s (64 bytes for P-256)
  const signatureB64 = base64UrlEncode(new Uint8Array(signature));

  return `${message}.${signatureB64}`;
}

/**
 * Import a PEM-encoded EC private key for use with SubtleCrypto.
 */
async function importPemKey(pemKey: string): Promise<CryptoKey> {
  // Normalize line endings and remove escapes
  let normalized = pemKey.replace(/\\n/g, "\n").trim();

  // Check if it's PEM format
  if (normalized.includes("-----BEGIN")) {
    // Extract the base64 content between PEM headers
    const pemMatch = normalized.match(
      /-----BEGIN[^-]+-----([^-]+)-----END[^-]+-----/,
    );
    if (!pemMatch) {
      throw new Error("Invalid PEM format");
    }
    normalized = pemMatch[1].replace(/\s/g, "");
  }

  // Decode base64 to get the DER-encoded key
  const binaryString = atob(normalized);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Import as PKCS#8 (standard for EC private keys)
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch (pkcs8Error) {
    // Try SEC1 format (raw EC key) wrapped in PKCS#8
    // Some tools export in SEC1 format - we need to wrap it
    console.log("PKCS#8 import failed, trying alternative formats", pkcs8Error);
    throw new Error(
      `Failed to import key: ${pkcs8Error instanceof Error ? pkcs8Error.message : String(pkcs8Error)}`,
    );
  }
}
