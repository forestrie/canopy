/**
 * Sharded Durable Object persistence for delegation control-plane state.
 *
 * Upstream: HTTP worker forwards per-log routes via {@link forwardToStore};
 * [arbor sealer](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * issues CBOR delegation requests and polls pending. Downstream: signed
 * webhooks to operator URLs; certificate PUT clears pending rows. Hierarchy and
 * BYOK flows per
 * [ARC-0017](https://github.com/forestrie/devdocs/blob/main/arc/arc-0017-hierarchical-authority-logs-and-fee-distribution.md).
 */

import { DurableObject } from "cloudflare:workers";
import { decodeCborStruct, encodeCbor } from "../cbor.js";
import type { Env } from "../env.js";
import { certificateKeyFor, sha256Hex } from "../certificate-key.js";
import { hex32ToWireLogIdBytes, logIdWireBytesToHex32 } from "../log-id.js";
import type { PutPublicRootBody } from "../types/put-public-root-body.js";
import type { TrustRootResponseCbor } from "../types/trust-root-response.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
} from "../types/trust-root-response.js";
import type { PublicRootMaterial } from "../validate-byok-certificate.js";
import { base64ToBytes, bytesToBase64 } from "../encoding.js";
import type { DelegationIssueRequest } from "../types/delegation-issue-request.js";
import type { DelegationIssueResponse } from "../types/delegation-issue-response.js";
import type { DelegationCertificateRecord } from "../types/delegation-certificate-record.js";
import type { PendingEntry } from "../types/pending-entry.js";
import type { PendingHintRequest } from "../types/pending-hint-request.js";
import type { RegisterDelegateKeysRequest } from "../types/register-delegate-keys-request.js";
import type { SigningRoute } from "../types/signing-route.js";
import type { SubmitDelegationCertificateRequest } from "../types/submit-delegation-certificate-request.js";
import type { PutWebhookRequest } from "../types/put-webhook-request.js";
import type { PutEnabledRequest } from "../types/put-enabled-request.js";
import type { WebhookConfigResponse } from "../types/webhook-config-response.js";
import type { EnabledResponse } from "../types/enabled-response.js";
import { delegationPendingResponse } from "../delegation-pending-response.js";
import {
  ByokCertificateValidationError,
  validateByokDelegationCertificate,
} from "../validate-byok-certificate.js";
import {
  buildOnchainDelegationToBeSignedEs256,
  buildOnchainDelegationToBeSignedKs256,
  decodeDelegatedCoseKeyFromBytes,
  normalizeEs256SignatureLowS,
  parseDelegatedCoseKeyFromPayload,
  verifyOnchainDelegationSignatureEs256,
  verifyOnchainDelegationSignatureKs256,
} from "@forestrie/delegation-cose";
import { createKs256RpcVerifyHooks } from "../ks256-rpc-verify-hooks.js";
import type { OnchainDelegationProofWire } from "../types/delegation-issue-response.js";
import {
  buildDelegationRequiredEvent,
  certificateSubmitUrlFromEnv,
} from "../webhook/build-delegation-required-event.js";
import { deliverSignedWebhook } from "../webhook/deliver-webhook.js";
import {
  computeRetryWaitMs,
  parseRetryConfig,
} from "../webhook/retry-config.js";

/** Pending row TTL before prune (seconds). */
const PENDING_TTL_SECONDS = 60 * 60;

/** Max pending hints retained per target log id. */
const PENDING_CAP_PER_LOG = 32;

function parseStoredOnchainRootAlg(
  value: string | null | undefined,
): "KS256" | "ES256" | null {
  if (value === "KS256" || value === "ES256") {
    return value;
  }
  return null;
}

/** Per-shard SQLite store for routes, certs, pending, webhooks. */
export class DelegationStoreDO extends DurableObject<Env> {
  private initialized = false;

  /** Bind Cloudflare DO state and worker env. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** Route internal fetch paths to store handlers. */
  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();

    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    try {
      const signingRouteMatch = /^\/signing-route\/([0-9a-f]{32})$/.exec(
        pathname,
      );
      if (signingRouteMatch) {
        const logIdHex32 = signingRouteMatch[1]!;
        if (method === "GET") {
          return this.handleGetSigningRoute(logIdHex32);
        }
        if (method === "PUT") {
          return this.handlePutSigningRoute(logIdHex32, request);
        }
      }

      const publicRootMatch = /^\/public-root\/([0-9a-f]{32})$/.exec(pathname);
      if (publicRootMatch) {
        const logIdHex32 = publicRootMatch[1]!;
        if (method === "GET") {
          return this.handleGetPublicRoot(logIdHex32);
        }
        if (method === "PUT") {
          return this.handlePutPublicRoot(logIdHex32, request);
        }
      }

      if (pathname === "/certificate" && method === "PUT") {
        return this.handlePutCertificate(request);
      }

      if (pathname === "/issue" && method === "POST") {
        return this.handleIssue(request);
      }

      if (pathname === "/pending" && method === "GET") {
        return this.handleGetPending(url);
      }

      if (pathname === "/pending-delegation" && method === "GET") {
        return this.handleGetPendingDelegation(url);
      }

      if (pathname === "/pending-hint" && method === "POST") {
        return this.handlePendingHint(request);
      }

      if (pathname === "/sealer/delegate-keys" && method === "PUT") {
        return this.handlePutDelegateKeys(request);
      }

      const webhookMatch = /^\/webhook\/([0-9a-f]{32})$/.exec(pathname);
      if (webhookMatch) {
        const logIdHex32 = webhookMatch[1]!;
        if (method === "GET") {
          return this.handleGetWebhookConfig(logIdHex32);
        }
        if (method === "PUT") {
          return this.handlePutWebhookConfig(logIdHex32, request);
        }
        if (method === "DELETE") {
          return this.handleDeleteWebhookConfig(logIdHex32);
        }
      }

      const enabledMatch =
        /^\/enabled\/([0-9a-f]{32})(?:\/(user|operator))?$/.exec(pathname);
      if (enabledMatch) {
        const logIdHex32 = enabledMatch[1]!;
        const authority = enabledMatch[2];
        if (method === "GET" && !authority) {
          return this.handleGetEnabled(logIdHex32);
        }
        if (method === "PUT" && authority === "user") {
          return this.handlePutUserEnabled(logIdHex32, request);
        }
        if (method === "PUT" && authority === "operator") {
          return this.handlePutOperatorEnabled(logIdHex32, request);
        }
      }

      if (pathname.startsWith("/")) {
        return Response.json(
          { type: "about:blank", title: "Not Found", status: 404 },
          { status: 404 },
        );
      }

      return new Response("DelegationStoreDO", { status: 200 });
    } catch (error) {
      console.error("DelegationStoreDO error:", error);
      return Response.json(
        {
          type: "about:blank",
          title: "Internal error",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 },
      );
    }
  }

  /** Create SQLite tables and run one-time migrations. */
  private ensureSchema(): void {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS signing_routes (
        log_id_hex32 TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        inherits_from TEXT,
        issuer_token TEXT,
        updated_at INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS delegation_certificates (
        log_id_hex32 TEXT NOT NULL,
        certificate_key TEXT NOT NULL,
        certificate BLOB NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (log_id_hex32, certificate_key)
      )
    `);

    this.ensureDelegationCertificatesMigrated();
    this.ensureOnchainSignatureColumn();
    this.ensureOnchainRootAlgColumn();
    this.ensureCertificateCoverageColumns();

    // Standing sealer delegate keys (FOR-390 phase C). Per-sealer, replicated
    // to every shard so a shard's coverage retrieval can LEFT JOIN it against
    // the log's certificates locally. Registration (POST
    // /api/sealer/delegate-keys) fans out to all shards.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS delegate_keys (
        pubkey_hash TEXT PRIMARY KEY,
        sealer_id TEXT NOT NULL,
        alg TEXT NOT NULL,
        public_key BLOB NOT NULL,
        epoch INTEGER NOT NULL,
        not_after INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS materials (
        log_id_hex32 TEXT NOT NULL,
        material_key TEXT NOT NULL,
        certificate BLOB NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (log_id_hex32, material_key)
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY,
        auth_log_id_hex32 TEXT NOT NULL,
        log_id_hex32 TEXT NOT NULL,
        mmr_start INTEGER NOT NULL,
        mmr_end INTEGER NOT NULL,
        delegated_pubkey_hash TEXT NOT NULL,
        delegated_public_key BLOB NOT NULL,
        requested_at INTEGER NOT NULL
      )
    `);

    this.ensurePendingDelegatedPublicKeyColumn();
    this.ctx.storage.sql.exec(
      `DELETE FROM pending WHERE length(delegated_public_key) = 0`,
    );

    this.ctx.storage.sql.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_log_range_pubkey
      ON pending (log_id_hex32, mmr_start, mmr_end, delegated_pubkey_hash)
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_auth_log
      ON pending (auth_log_id_hex32, requested_at DESC)
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS public_roots (
        log_id_hex32 TEXT PRIMARY KEY,
        alg TEXT NOT NULL,
        x BLOB NOT NULL,
        y BLOB NOT NULL,
        uploaded_at INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS log_delegation_config (
        log_id_hex32 TEXT PRIMARY KEY,
        webhook_url TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        user_enabled INTEGER NOT NULL DEFAULT 1,
        operator_enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.ensureEnabledAuthorityColumns();

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        request_key TEXT PRIMARY KEY,
        log_id_hex32 TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next
      ON webhook_deliveries (next_attempt_at)
    `);

    this.initialized = true;
  }

  /** Copy legacy materials rows into delegation_certificates when present. */
  private ensureDelegationCertificatesMigrated(): void {
    try {
      this.ctx.storage.sql.exec(`
        INSERT OR IGNORE INTO delegation_certificates
          (log_id_hex32, certificate_key, certificate, issued_at, expires_at)
        SELECT log_id_hex32, material_key, certificate, issued_at, expires_at
        FROM materials
      `);
    } catch {
      // materials table may not exist on fresh installs
    }
  }

  /** Add onchain_signature column to delegation_certificates on legacy DBs. */
  private ensureOnchainSignatureColumn(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT onchain_signature FROM delegation_certificates LIMIT 0`,
        ),
      ];
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE delegation_certificates ADD COLUMN onchain_signature BLOB`,
      );
    }
  }

  /**
   * Add onchain_root_alg column so issue rebuilds the proof under the alg the
   * signature was validated against (roots are replaceable via POST /public-root).
   */
  private ensureOnchainRootAlgColumn(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT onchain_root_alg FROM delegation_certificates LIMIT 0`,
        ),
      ];
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE delegation_certificates ADD COLUMN onchain_root_alg TEXT`,
      );
    }
  }

  /**
   * Add coverage columns to delegation_certificates (FOR-390 phase C). The
   * opaque certificate_key folds (mmrStart, mmrEnd, delegatedKey) together for
   * exact-match; coverage retrieval needs them as first-class columns. The
   * SIGNED range persisted here — never the issue request's range — is what
   * the issue response's onchainProof is rebuilt from (review V1). Kept
   * alongside certificate_key for rollback compatibility.
   */
  private ensureCertificateCoverageColumns(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT mmr_start FROM delegation_certificates LIMIT 0`,
        ),
      ];
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE delegation_certificates ADD COLUMN delegated_pubkey_hash TEXT`,
      );
      this.ctx.storage.sql.exec(
        `ALTER TABLE delegation_certificates ADD COLUMN delegated_public_key BLOB`,
      );
      this.ctx.storage.sql.exec(
        `ALTER TABLE delegation_certificates ADD COLUMN mmr_start INTEGER`,
      );
      this.ctx.storage.sql.exec(
        `ALTER TABLE delegation_certificates ADD COLUMN mmr_end INTEGER`,
      );
    }
    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_delegation_certificates_coverage
      ON delegation_certificates (log_id_hex32, expires_at, mmr_start, mmr_end)
    `);
  }

  /** Add user_enabled / operator_enabled columns on legacy databases. */
  private ensureEnabledAuthorityColumns(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT user_enabled FROM log_delegation_config LIMIT 0`,
        ),
      ];
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE log_delegation_config ADD COLUMN user_enabled INTEGER NOT NULL DEFAULT 1`,
      );
      this.ctx.storage.sql.exec(
        `ALTER TABLE log_delegation_config ADD COLUMN operator_enabled INTEGER NOT NULL DEFAULT 1`,
      );
      this.ctx.storage.sql.exec(
        `UPDATE log_delegation_config
         SET operator_enabled = enabled, user_enabled = 1`,
      );
    }
  }

  /** Add delegated_public_key column to pending on legacy databases. */
  private ensurePendingDelegatedPublicKeyColumn(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT delegated_public_key FROM pending LIMIT 0`,
        ),
      ];
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE pending ADD COLUMN delegated_public_key BLOB NOT NULL DEFAULT X''`,
      );
    }
  }

  /** Drop expired and over-cap pending rows for a log. */
  private prunePending(logIdHex32: string, nowSeconds: number): void {
    const cutoff = nowSeconds - PENDING_TTL_SECONDS;
    this.ctx.storage.sql.exec(
      `DELETE FROM pending WHERE requested_at < ?`,
      cutoff,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM pending
       WHERE log_id_hex32 = ?
         AND id NOT IN (
           SELECT id FROM pending
           WHERE log_id_hex32 = ?
           ORDER BY requested_at DESC
           LIMIT ?
         )`,
      logIdHex32,
      logIdHex32,
      PENDING_CAP_PER_LOG,
    );
  }

  /** GET /signing-route/{logIdHex32} — read signing route JSON. */
  private handleGetSigningRoute(logIdHex32: string): Response {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT mode, inherits_from, issuer_token FROM signing_routes WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];

    if (rows.length === 0) {
      return Response.json(
        { type: "about:blank", title: "Not Found", status: 404 },
        { status: 404 },
      );
    }

    const row = rows[0] as {
      mode: string;
      inherits_from: string | null;
      issuer_token: string | null;
    };

    const route: SigningRoute = { mode: row.mode as SigningRoute["mode"] };
    if (row.inherits_from) route.inheritsFrom = row.inherits_from;
    if (row.issuer_token) route.issuerToken = row.issuer_token;

    return Response.json(route);
  }

  /** PUT /signing-route/{logIdHex32} — upsert signing route. */
  private async handlePutSigningRoute(
    logIdHex32: string,
    request: Request,
  ): Promise<Response> {
    const body = (await request.json()) as SigningRoute;
    if (body.mode !== "wallet" && body.mode !== "http") {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "mode must be wallet or http",
        },
        { status: 400 },
      );
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO signing_routes (log_id_hex32, mode, inherits_from, issuer_token, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         mode = excluded.mode,
         inherits_from = excluded.inherits_from,
         issuer_token = excluded.issuer_token,
         updated_at = excluded.updated_at`,
      logIdHex32,
      body.mode,
      body.inheritsFrom ?? null,
      body.issuerToken ?? null,
      Date.now(),
    );

    return Response.json({ ok: true });
  }

  /** PUT /public-root/{logIdHex32} — store BYOK public root. */
  private async handlePutPublicRoot(
    logIdHex32: string,
    request: Request,
  ): Promise<Response> {
    const body = (await request.json()) as PutPublicRootBody;
    if (body.logIdHex32 !== logIdHex32) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "logIdHex32 in body must match path",
        },
        { status: 400 },
      );
    }

    const algRaw = body.alg;
    if (algRaw === "ES256") {
      if (!body.x || !body.y) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "x and y are required for ES256",
          },
          { status: 400 },
        );
      }
      const x = base64ToBytes(body.x);
      const y = base64ToBytes(body.y);
      if (x.length !== 32 || y.length !== 32) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "x and y must each decode to 32 bytes",
          },
          { status: 400 },
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO public_roots (log_id_hex32, alg, x, y, uploaded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(log_id_hex32) DO UPDATE SET
           alg = excluded.alg,
           x = excluded.x,
           y = excluded.y,
           uploaded_at = excluded.uploaded_at`,
        logIdHex32,
        body.alg,
        x,
        y,
        Date.now(),
      );
      return Response.json({ ok: true });
    }

    const algInt =
      typeof algRaw === "number"
        ? algRaw
        : typeof algRaw === "string"
          ? Number(algRaw)
          : NaN;
    if (algInt !== COSE_ALG_ES256 && algInt !== COSE_ALG_KS256) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "alg must be ES256, -7, or -65799",
        },
        { status: 400 },
      );
    }
    if (!body.key) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "key is required for alg int public roots",
        },
        { status: 400 },
      );
    }
    const key = base64ToBytes(body.key);
    const expectedLen = algInt === COSE_ALG_KS256 ? 20 : 64;
    if (key.length !== expectedLen) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: `key must decode to ${expectedLen} bytes for alg ${algInt}`,
        },
        { status: 400 },
      );
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO public_roots (log_id_hex32, alg, x, y, uploaded_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         alg = excluded.alg,
         x = excluded.x,
         y = excluded.y,
         uploaded_at = excluded.uploaded_at`,
      logIdHex32,
      String(algInt),
      key,
      new Uint8Array(0),
      Date.now(),
    );

    return Response.json({ ok: true });
  }

  /** Map SQLite public_roots row to validation PublicRootMaterial. */
  private publicRootMaterialFromRow(row: {
    alg: string;
    x: ArrayBuffer;
    y: ArrayBuffer;
  }): PublicRootMaterial {
    if (row.alg === "ES256") {
      return {
        alg: "ES256",
        x: new Uint8Array(row.x),
        y: new Uint8Array(row.y),
      };
    }
    const algInt = Number(row.alg);
    if (algInt === COSE_ALG_KS256) {
      return { alg: "KS256", key: new Uint8Array(row.x) };
    }
    throw new ByokCertificateValidationError(
      `unsupported stored public root alg ${row.alg}`,
    );
  }

  /** Map stored row to trust-root CBOR for GET public-root. */
  private trustRootCborFromRow(
    logIdHex32: string,
    row: { alg: string; x: ArrayBuffer; y: ArrayBuffer },
  ): TrustRootResponseCbor {
    const logId = hex32ToWireLogIdBytes(logIdHex32);
    if (row.alg === "ES256") {
      return {
        logId,
        alg: "ES256",
        x: new Uint8Array(row.x),
        y: new Uint8Array(row.y),
      };
    }
    const algInt = Number(row.alg);
    if (algInt === COSE_ALG_KS256 || algInt === COSE_ALG_ES256) {
      return {
        logId,
        alg: algInt,
        key: new Uint8Array(row.x),
      };
    }
    throw new Error(`unsupported stored public root alg ${row.alg}`);
  }

  /** GET /public-root/{logIdHex32} — CBOR trust-root response. */
  private handleGetPublicRoot(logIdHex32: string): Response {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT alg, x, y FROM public_roots WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];

    if (rows.length === 0) {
      const bytes = encodeCbor({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "public root not uploaded for log",
      });
      return new Response(bytes, {
        status: 404,
        headers: { "Content-Type": "application/problem+cbor" },
      });
    }

    const row = rows[0] as {
      alg: string;
      x: ArrayBuffer;
      y: ArrayBuffer;
    };

    let resp: TrustRootResponseCbor;
    try {
      resp = this.trustRootCborFromRow(logIdHex32, row);
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "invalid stored public root";
      const bytes = encodeCbor({
        type: "about:blank",
        title: "Internal error",
        status: 500,
        detail,
      });
      return new Response(bytes, {
        status: 500,
        headers: { "Content-Type": "application/problem+cbor" },
      });
    }

    const out = encodeCbor(resp);
    return new Response(out, {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  }

  /** PUT /certificate — validate and persist delegation certificate. */
  private async handlePutCertificate(request: Request): Promise<Response> {
    const body = (await request.json()) as SubmitDelegationCertificateRequest;
    const logIdHex32 = body.logId;
    const delegatedPublicKey = base64ToBytes(body.delegatedPublicKey);
    const certificate = base64ToBytes(body.certificate);

    const rootRows = [
      ...this.ctx.storage.sql.exec(
        `SELECT alg, x, y FROM public_roots WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    if (rootRows.length === 0) {
      return Response.json(
        {
          type: "about:blank",
          title: "Not Found",
          status: 404,
          detail: "public root not uploaded for log",
        },
        { status: 404 },
      );
    }
    const rootRow = rootRows[0] as {
      alg: string;
      x: ArrayBuffer;
      y: ArrayBuffer;
    };
    try {
      await validateByokDelegationCertificate({
        logIdHex32,
        mmrStart: body.mmrStart,
        mmrEnd: body.mmrEnd,
        delegatedPublicKey,
        certificate,
        issuedAt: body.issuedAt,
        expiresAt: body.expiresAt,
        publicRoot: this.publicRootMaterialFromRow(rootRow),
        ks256RpcUrl: this.env.KS256_RPC_URL,
      });
    } catch (error) {
      const detail =
        error instanceof ByokCertificateValidationError
          ? error.message
          : error instanceof Error
            ? error.message
            : "invalid delegation certificate";
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail,
        },
        { status: 400 },
      );
    }

    let onchainSignature: Uint8Array | null = null;
    let onchainRootAlg: "KS256" | "ES256" | null = null;
    if (body.onchainSignature) {
      const root = this.publicRootMaterialFromRow(rootRow);
      let signature: Uint8Array;
      try {
        signature = base64ToBytes(body.onchainSignature);
      } catch {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "onchainSignature must be valid base64",
          },
          { status: 400 },
        );
      }
      const delegated = parseDelegatedCoseKeyFromPayload(
        decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
      );
      const scope = {
        logIdHex: logIdHex32,
        mmrStart: body.mmrStart,
        mmrEnd: body.mmrEnd,
        delegatedKeyX: delegated.x,
        delegatedKeyY: delegated.y,
      };
      let ok: boolean;
      if (root.alg === "KS256") {
        const hooks = this.env.KS256_RPC_URL
          ? createKs256RpcVerifyHooks(this.env.KS256_RPC_URL)
          : undefined;
        ok = await verifyOnchainDelegationSignatureKs256(
          scope,
          signature,
          root.key,
          hooks,
        );
      } else {
        // The contract's P256 verifier rejects malleable high-s signatures;
        // store the normalized form since signers make no low-s guarantee.
        signature = normalizeEs256SignatureLowS(signature);
        ok = await verifyOnchainDelegationSignatureEs256(
          scope,
          signature,
          root.x,
          root.y,
        );
      }
      if (!ok) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "onchainSignature does not verify against the public root",
          },
          { status: 400 },
        );
      }
      onchainSignature = signature;
      onchainRootAlg = root.alg;
    }

    const key = await certificateKeyFor(
      body.mmrStart,
      body.mmrEnd,
      delegatedPublicKey,
    );
    const pubkeyHash = await sha256Hex(delegatedPublicKey);

    this.ctx.storage.sql.exec(
      `INSERT INTO delegation_certificates
         (log_id_hex32, certificate_key, certificate, issued_at, expires_at,
          onchain_signature, onchain_root_alg,
          delegated_pubkey_hash, delegated_public_key, mmr_start, mmr_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32, certificate_key) DO UPDATE SET
         certificate = excluded.certificate,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at,
         onchain_signature = excluded.onchain_signature,
         onchain_root_alg = excluded.onchain_root_alg,
         delegated_pubkey_hash = excluded.delegated_pubkey_hash,
         delegated_public_key = excluded.delegated_public_key,
         mmr_start = excluded.mmr_start,
         mmr_end = excluded.mmr_end`,
      logIdHex32,
      key,
      certificate,
      body.issuedAt,
      body.expiresAt,
      onchainSignature,
      onchainRootAlg,
      pubkeyHash,
      delegatedPublicKey,
      body.mmrStart,
      body.mmrEnd,
    );

    this.ctx.storage.sql.exec(
      `DELETE FROM pending
       WHERE log_id_hex32 = ? AND mmr_start = ? AND mmr_end = ? AND delegated_pubkey_hash = ?`,
      logIdHex32,
      body.mmrStart,
      body.mmrEnd,
      pubkeyHash,
    );

    return Response.json({ ok: true, certificateKey: key });
  }

  /** POST /issue — return cert CBOR or record pending + webhook. */
  private async handleIssue(request: Request): Promise<Response> {
    const buffer = await request.arrayBuffer();
    const req = decodeCborStruct<DelegationIssueRequest>(
      new Uint8Array(buffer),
    );

    const logIdHex32 = logIdWireBytesToHex32(req.logId);
    if (!this.isDelegationSurfacingEnabled(logIdHex32)) {
      return delegationPendingResponse(202);
    }

    // Coverage retrieval (FOR-390 phase C): the newest unexpired certificate
    // that COVERS the true seal window [mmrStart, mmrEnd], bound to either the
    // request's own delegated key or any registered standing delegate key
    // (rotation overlap — a still-valid wide cert bound to the epoch N-1 key
    // is usable while the request advertises epoch N). Replaces the exact
    // certificate_key match, so one wide advance cert serves every subsequent
    // narrow seal without a signer round-trip.
    const reqKeyHash = await sha256Hex(req.delegatedPublicKey);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT c.certificate, c.issued_at, c.expires_at, c.onchain_signature,
                c.onchain_root_alg, c.delegated_public_key,
                c.mmr_start, c.mmr_end
           FROM delegation_certificates c
           LEFT JOIN delegate_keys k
             ON k.pubkey_hash = c.delegated_pubkey_hash AND k.not_after > ?
          WHERE c.log_id_hex32 = ?
            AND c.expires_at > ?
            AND c.mmr_start <= ?
            AND c.mmr_end >= ?
            AND (c.delegated_pubkey_hash = ? OR k.pubkey_hash IS NOT NULL)
          ORDER BY c.expires_at DESC, c.mmr_end DESC
          LIMIT 1`,
        nowSeconds,
        logIdHex32,
        nowSeconds,
        req.mmrStart,
        req.mmrEnd,
        reqKeyHash,
      ),
    ];

    if (rows.length === 0) {
      // Legacy fallback (review F3): pre-migration certs have NULL coverage
      // columns and are invisible to coverage retrieval. Preserve exact-match
      // for them until they refresh within TTL. An exact certificate_key hit
      // means request range == certificate range, so building the proof from
      // the request range is correct (the V1 hazard only applies to coverage).
      const legacy = await this.issueFromLegacyExactMatch(
        logIdHex32,
        req,
        nowSeconds,
      );
      if (legacy) return legacy;

      const pubkeyHash = reqKeyHash;
      const now = nowSeconds;
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT INTO pending
         (id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end,
          delegated_pubkey_hash, delegated_public_key, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(log_id_hex32, mmr_start, mmr_end, delegated_pubkey_hash)
         DO UPDATE SET
           auth_log_id_hex32 = excluded.auth_log_id_hex32,
           delegated_public_key = excluded.delegated_public_key,
           requested_at = excluded.requested_at`,
        id,
        logIdHex32,
        logIdHex32,
        req.mmrStart,
        req.mmrEnd,
        pubkeyHash,
        req.delegatedPublicKey,
        now,
      );
      this.prunePending(logIdHex32, now);

      this.ctx.waitUntil(
        this.enqueueWebhookDelivery({
          logIdHex32,
          authLogIdHex32: logIdHex32,
          mmrStart: req.mmrStart,
          mmrEnd: req.mmrEnd,
          delegatedPublicKey: req.delegatedPublicKey,
          delegatedPubkeyHash: pubkeyHash,
          requestedAt: now,
        }),
      );

      return delegationPendingResponse(202);
    }

    const row = rows[0] as {
      certificate: ArrayBuffer;
      issued_at: number;
      expires_at: number;
      onchain_signature: ArrayBuffer | null;
      onchain_root_alg: string | null;
      delegated_public_key: ArrayBuffer | null;
      mmr_start: number | null;
      mmr_end: number | null;
    };

    const certificateBytes = new Uint8Array(row.certificate);
    const resp: DelegationIssueResponse = {
      version: 1,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      certificate: certificateBytes,
    };

    if (row.onchain_signature) {
      const storedAlg = parseStoredOnchainRootAlg(row.onchain_root_alg);
      const currentAlg = this.rootAlgForLog(logIdHex32);
      if (
        storedAlg !== null &&
        currentAlg !== null &&
        storedAlg !== currentAlg
      ) {
        console.warn(
          "onchainProofFromStored: omitting proof after public-root alg rotation",
          { logIdHex32, storedAlg, currentAlg },
        );
      } else if (
        row.delegated_public_key &&
        row.mmr_start !== null &&
        row.mmr_end !== null
      ) {
        // Review V1 (publishing breaks without this): the stored on-chain
        // signature was made over the CERTIFICATE's range and key. Under
        // coverage retrieval the request's narrow window differs from the
        // signed range, so the proof MUST be rebuilt from the row's own
        // columns — pairing the stored signature with the request range makes
        // the on-chain P256.verify fail at publishCheckpoint. The on-chain
        // range check is coverage (mmrIndex ∈ [start, end]), so the wider
        // certificate range verifies the narrow seal correctly.
        // Prefer the alg persisted at validation time; legacy rows (null)
        // fall back to the live root — same behaviour as pre-R1.
        const onchainProof = this.onchainProofFromStored(
          logIdHex32,
          row.mmr_start,
          row.mmr_end,
          new Uint8Array(row.delegated_public_key),
          new Uint8Array(row.onchain_signature),
          storedAlg ?? currentAlg,
        );
        if (onchainProof) {
          resp.onchainProof = onchainProof;
        }
      }
    }

    const out = encodeCbor(resp);
    return new Response(out, {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  }

  /**
   * Root algorithm for a log ("KS256" | "ES256"), or null when no public
   * root is stored (a stored onchainSignature always implies one — it was
   * validated against the root on submission).
   */
  private rootAlgForLog(logIdHex32: string): "KS256" | "ES256" | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT alg, x, y FROM public_roots WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    if (rows.length === 0) {
      return null;
    }
    try {
      return this.publicRootMaterialFromRow(
        rows[0] as { alg: string; x: ArrayBuffer; y: ArrayBuffer },
      ).alg;
    } catch {
      return null;
    }
  }

  /**
   * Rebuild the wire onchainProof from stored signature bytes plus the issue
   * request's scope (the certificate key already binds range and key). The
   * protected header carries the root's algorithm, so the builder is chosen
   * by the alg the signature was validated against (persisted at submit).
   * Returns null when the delegated key CBOR cannot be parsed or the root
   * alg is unknown — callers must log; silent omission surfaces later as a
   * publisher revert.
   */
  private onchainProofFromStored(
    logIdHex32: string,
    mmrStart: number,
    mmrEnd: number,
    delegatedPublicKey: Uint8Array,
    signature: Uint8Array,
    rootAlg: "KS256" | "ES256" | null,
  ): OnchainDelegationProofWire | null {
    if (rootAlg === null) {
      console.warn("onchainProofFromStored: unknown root alg", {
        logIdHex32,
      });
      return null;
    }
    try {
      const delegated = parseDelegatedCoseKeyFromPayload(
        decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
      );
      const buildTbs =
        rootAlg === "KS256"
          ? buildOnchainDelegationToBeSignedKs256
          : buildOnchainDelegationToBeSignedEs256;
      const tbs = buildTbs({
        logIdHex: logIdHex32,
        mmrStart,
        mmrEnd,
        delegatedKeyX: delegated.x,
        delegatedKeyY: delegated.y,
      });
      return {
        protectedHeader: tbs.protectedHeader,
        delegationKey: tbs.delegationKey,
        mmrStart: BigInt(mmrStart),
        mmrEnd: BigInt(mmrEnd),
        signature,
      };
    } catch (error) {
      console.warn("onchainProofFromStored: delegated-key parse failed", {
        logIdHex32,
        rootAlg,
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Legacy exact-match issue path (review F3). Serves an unexpired certificate
   * for a pre-migration row (NULL coverage columns) via the opaque
   * certificate_key, reproducing pre-FOR-390 behaviour so those logs do not
   * regress to pending until their certs refresh. Scoped to `mmr_start IS NULL`
   * so migrated rows are only ever served through coverage retrieval. Returns
   * null on miss (caller falls through to the pending path).
   */
  private async issueFromLegacyExactMatch(
    logIdHex32: string,
    req: DelegationIssueRequest,
    nowSeconds: number,
  ): Promise<Response | null> {
    const key = await certificateKeyFor(
      req.mmrStart,
      req.mmrEnd,
      req.delegatedPublicKey,
    );
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT certificate, issued_at, expires_at, onchain_signature,
                onchain_root_alg
           FROM delegation_certificates
          WHERE log_id_hex32 = ? AND certificate_key = ?
            AND mmr_start IS NULL AND expires_at > ?`,
        logIdHex32,
        key,
        nowSeconds,
      ),
    ];
    if (rows.length === 0) return null;

    const row = rows[0] as {
      certificate: ArrayBuffer;
      issued_at: number;
      expires_at: number;
      onchain_signature: ArrayBuffer | null;
      onchain_root_alg: string | null;
    };
    const resp: DelegationIssueResponse = {
      version: 1,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      certificate: new Uint8Array(row.certificate),
    };
    if (row.onchain_signature) {
      const storedAlg = parseStoredOnchainRootAlg(row.onchain_root_alg);
      const currentAlg = this.rootAlgForLog(logIdHex32);
      if (
        !(storedAlg !== null && currentAlg !== null && storedAlg !== currentAlg)
      ) {
        // Exact match ⇒ request range == certificate range, so the request
        // scope is the signed scope — the V1 hazard does not apply here.
        const onchainProof = this.onchainProofFromStored(
          logIdHex32,
          req.mmrStart,
          req.mmrEnd,
          req.delegatedPublicKey,
          new Uint8Array(row.onchain_signature),
          storedAlg ?? currentAlg,
        );
        if (onchainProof) resp.onchainProof = onchainProof;
      }
    }
    return new Response(encodeCbor(resp), {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  }

  /** GET /pending?authLogId= — operator pending list by auth log. */
  private handleGetPending(url: URL): Response {
    const authLogId = url.searchParams.get("authLogId");
    if (!authLogId) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "authLogId query parameter is required",
        },
        { status: 400 },
      );
    }

    const offset = Math.max(
      0,
      parseInt(url.searchParams.get("offset") ?? "0", 10),
    );
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Math.min(Math.max(1, limitRaw), 500);

    const now = Math.floor(Date.now() / 1000);
    this.prunePending(authLogId, now);

    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end,
              delegated_pubkey_hash, delegated_public_key, requested_at
       FROM pending
       WHERE auth_log_id_hex32 = ?
         AND COALESCE(
           (SELECT (user_enabled != 0 AND operator_enabled != 0)
            FROM log_delegation_config c
            WHERE c.log_id_hex32 = pending.log_id_hex32),
           1
         ) = 1
       ORDER BY requested_at DESC
       LIMIT ? OFFSET ?`,
        authLogId,
        limit,
        offset,
      ),
    ];

    const entries: PendingEntry[] = rows.map((row) => {
      const r = row as {
        id: string;
        auth_log_id_hex32: string;
        log_id_hex32: string;
        mmr_start: number;
        mmr_end: number;
        delegated_pubkey_hash: string;
        delegated_public_key: ArrayBuffer;
        requested_at: number;
      };
      return {
        id: r.id,
        authLogIdHex32: r.auth_log_id_hex32,
        logIdHex32: r.log_id_hex32,
        mmrStart: r.mmr_start,
        mmrEnd: r.mmr_end,
        delegatedPublicKeyHash: r.delegated_pubkey_hash,
        delegatedPublicKey: bytesToBase64(
          new Uint8Array(r.delegated_public_key),
        ),
        requestedAt: r.requested_at,
      };
    });

    return Response.json({ entries, offset, limit });
  }

  /** GET /pending-delegation?logId= — sealer-style pending for one log. */
  private handleGetPendingDelegation(url: URL): Response {
    const logIdHex32 = url.searchParams.get("logId");
    if (!logIdHex32) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "logId query parameter is required",
        },
        { status: 400 },
      );
    }

    if (!this.isDelegationSurfacingEnabled(logIdHex32)) {
      return Response.json({ entries: [], limit: PENDING_CAP_PER_LOG });
    }

    const now = Math.floor(Date.now() / 1000);
    this.prunePending(logIdHex32, now);

    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end,
              delegated_pubkey_hash, delegated_public_key, requested_at
       FROM pending
       WHERE log_id_hex32 = ?
       ORDER BY requested_at DESC
       LIMIT ?`,
        logIdHex32,
        PENDING_CAP_PER_LOG,
      ),
    ];

    const entries: PendingEntry[] = rows.map((row) => {
      const r = row as {
        id: string;
        auth_log_id_hex32: string;
        log_id_hex32: string;
        mmr_start: number;
        mmr_end: number;
        delegated_pubkey_hash: string;
        delegated_public_key: ArrayBuffer;
        requested_at: number;
      };
      return {
        id: r.id,
        authLogIdHex32: r.auth_log_id_hex32,
        logIdHex32: r.log_id_hex32,
        mmrStart: r.mmr_start,
        mmrEnd: r.mmr_end,
        delegatedPublicKeyHash: r.delegated_pubkey_hash,
        delegatedPublicKey: bytesToBase64(
          new Uint8Array(r.delegated_public_key),
        ),
        requestedAt: r.requested_at,
      };
    });

    return Response.json({ entries, limit: PENDING_CAP_PER_LOG });
  }

  /** POST /pending-hint — upsert pending row from worker hint. */
  private async handlePendingHint(request: Request): Promise<Response> {
    const body = (await request.json()) as PendingHintRequest;
    const authLogIdHex32 = body.authLogId;
    const logIdHex32 = body.logId;
    const delegatedPublicKey = base64ToBytes(body.delegatedPublicKey);
    const pubkeyHash = await sha256Hex(delegatedPublicKey);
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();

    this.ctx.storage.sql.exec(
      `INSERT INTO pending
       (id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end,
        delegated_pubkey_hash, delegated_public_key, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32, mmr_start, mmr_end, delegated_pubkey_hash)
       DO UPDATE SET
         auth_log_id_hex32 = excluded.auth_log_id_hex32,
         delegated_public_key = excluded.delegated_public_key,
         requested_at = excluded.requested_at`,
      id,
      authLogIdHex32,
      logIdHex32,
      body.mmrStart,
      body.mmrEnd,
      pubkeyHash,
      delegatedPublicKey,
      now,
    );
    this.prunePending(logIdHex32, now);

    return Response.json({ ok: true, id });
  }

  /**
   * PUT /sealer/delegate-keys — idempotent upsert of a sealer's standing
   * delegate keys (FOR-390 phase C). Each shard holds a replica so coverage
   * retrieval can LEFT JOIN it locally against that log's certificates; the
   * worker fans registration out to every shard. Also retires (deletes) this
   * sealer's keys whose not_after has passed. pubkey_hash is
   * sha256(publicKey CBOR) so it equals the certificate's
   * delegated_pubkey_hash.
   */
  private async handlePutDelegateKeys(request: Request): Promise<Response> {
    const body = (await request.json()) as RegisterDelegateKeysRequest;
    if (!body.sealerId || !Array.isArray(body.keys)) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "sealerId and keys[] are required",
        },
        { status: 400 },
      );
    }

    const now = Math.floor(Date.now() / 1000);
    let registered = 0;
    for (const key of body.keys) {
      if (key.alg !== "ES256") {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: `unsupported delegate key alg ${key.alg}`,
          },
          { status: 400 },
        );
      }
      let publicKey: Uint8Array;
      try {
        publicKey = base64ToBytes(key.publicKey);
      } catch {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "publicKey must be valid base64",
          },
          { status: 400 },
        );
      }
      if (publicKey.length === 0) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "publicKey must be non-empty",
          },
          { status: 400 },
        );
      }
      if (!Number.isFinite(key.epoch) || key.epoch < 1) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "epoch must be >= 1",
          },
          { status: 400 },
        );
      }
      // Reject an already-expired notAfter rather than silently storing then
      // retiring it in the same request (review F6).
      if (!Number.isFinite(key.notAfter) || key.notAfter <= now) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "notAfter must be in the future",
          },
          { status: 400 },
        );
      }
      const pubkeyHash = await sha256Hex(publicKey);
      this.ctx.storage.sql.exec(
        `INSERT INTO delegate_keys
           (pubkey_hash, sealer_id, alg, public_key, epoch, not_after)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pubkey_hash) DO UPDATE SET
           sealer_id = excluded.sealer_id,
           alg = excluded.alg,
           public_key = excluded.public_key,
           epoch = excluded.epoch,
           not_after = excluded.not_after`,
        pubkeyHash,
        body.sealerId,
        key.alg,
        publicKey,
        key.epoch,
        key.notAfter,
      );
      registered += 1;
    }

    const retiredRows = [
      ...this.ctx.storage.sql.exec(
        `SELECT COUNT(*) AS n FROM delegate_keys
          WHERE sealer_id = ? AND not_after <= ?`,
        body.sealerId,
        now,
      ),
    ];
    const retired = Number((retiredRows[0] as { n: number }).n);
    this.ctx.storage.sql.exec(
      `DELETE FROM delegate_keys WHERE sealer_id = ? AND not_after <= ?`,
      body.sealerId,
      now,
    );

    return Response.json({ registered, retired });
  }

  /** Default true when no config row exists (same as webhook CRUD defaults). */
  private isDelegationSurfacingEnabled(logIdHex32: string): boolean {
    const row = this.readDelegationConfigRow(logIdHex32);
    if (!row) return true;
    return this.effectiveEnabled(row);
  }

  /** Effective enabled when user and operator flags are both true. */
  private effectiveEnabled(row: {
    user_enabled: number;
    operator_enabled: number;
  }): boolean {
    return row.user_enabled !== 0 && row.operator_enabled !== 0;
  }

  /** Read log_delegation_config row or null when unset. */
  private readDelegationConfigRow(logIdHex32: string): {
    webhook_url: string | null;
    enabled: number;
    user_enabled: number;
    operator_enabled: number;
    created_at: number;
    updated_at: number;
  } | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT webhook_url, enabled, user_enabled, operator_enabled,
                created_at, updated_at
         FROM log_delegation_config WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    if (rows.length === 0) return null;
    return rows[0] as {
      webhook_url: string | null;
      enabled: number;
      user_enabled: number;
      operator_enabled: number;
      created_at: number;
      updated_at: number;
    };
  }

  /** Map config row to public webhook JSON (no secrets). */
  private webhookConfigResponseFromRow(row: {
    webhook_url: string | null;
    user_enabled: number;
    operator_enabled: number;
    created_at: number;
    updated_at: number;
  }): WebhookConfigResponse {
    const resp: WebhookConfigResponse = {
      enabled: this.effectiveEnabled(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.webhook_url) {
      resp.webhookUrl = row.webhook_url;
    }
    return resp;
  }

  /** GET /webhook/{logIdHex32} — read webhook config JSON. */
  private handleGetWebhookConfig(logIdHex32: string): Response {
    const row = this.readDelegationConfigRow(logIdHex32);
    if (!row) {
      return Response.json(
        { type: "about:blank", title: "Not Found", status: 404 },
        { status: 404 },
      );
    }
    return Response.json(this.webhookConfigResponseFromRow(row));
  }

  /** PUT /webhook/{logIdHex32} — set webhook URL. */
  private async handlePutWebhookConfig(
    logIdHex32: string,
    request: Request,
  ): Promise<Response> {
    const body = (await request.json()) as PutWebhookRequest;
    if (!body.url || typeof body.url !== "string") {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "url is required",
        },
        { status: 400 },
      );
    }

    const now = Date.now();
    const existing = this.readDelegationConfigRow(logIdHex32);
    const userEnabled = existing?.user_enabled ?? 1;
    const operatorEnabled = existing?.operator_enabled ?? 1;
    const createdAt = existing?.created_at ?? now;

    this.ctx.storage.sql.exec(
      `INSERT INTO log_delegation_config
         (log_id_hex32, webhook_url, enabled, user_enabled, operator_enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         webhook_url = excluded.webhook_url,
         updated_at = excluded.updated_at`,
      logIdHex32,
      body.url,
      userEnabled && operatorEnabled ? 1 : 0,
      userEnabled,
      operatorEnabled,
      createdAt,
      now,
    );

    const row = this.readDelegationConfigRow(logIdHex32);
    return Response.json(
      row ? this.webhookConfigResponseFromRow(row) : { ok: true },
    );
  }

  /** DELETE /webhook/{logIdHex32} — clear webhook URL. */
  private handleDeleteWebhookConfig(logIdHex32: string): Response {
    const now = Date.now();
    const existing = this.readDelegationConfigRow(logIdHex32);
    if (!existing) {
      return Response.json({ ok: true });
    }

    this.ctx.storage.sql.exec(
      `UPDATE log_delegation_config
       SET webhook_url = NULL, updated_at = ?
       WHERE log_id_hex32 = ?`,
      now,
      logIdHex32,
    );

    return Response.json({ ok: true });
  }

  /** GET /enabled/{logIdHex32} — read enabled flags JSON. */
  private handleGetEnabled(logIdHex32: string): Response {
    const row = this.readDelegationConfigRow(logIdHex32);
    if (!row) {
      return Response.json(
        { type: "about:blank", title: "Not Found", status: 404 },
        { status: 404 },
      );
    }
    const resp: EnabledResponse = {
      enabled: this.effectiveEnabled(row),
      userEnabled: row.user_enabled !== 0,
      operatorEnabled: row.operator_enabled !== 0,
    };
    return Response.json(resp);
  }

  /** PUT /enabled/{logIdHex32}/user — user kill-switch write. */
  private async handlePutUserEnabled(
    logIdHex32: string,
    request: Request,
  ): Promise<Response> {
    return this.handlePutEnabledAuthority(logIdHex32, request, "user");
  }

  /** PUT /enabled/{logIdHex32}/operator — operator kill-switch write. */
  private async handlePutOperatorEnabled(
    logIdHex32: string,
    request: Request,
  ): Promise<Response> {
    return this.handlePutEnabledAuthority(logIdHex32, request, "operator");
  }

  /** Shared PUT handler for user or operator enabled authority. */
  private async handlePutEnabledAuthority(
    logIdHex32: string,
    request: Request,
    authority: "user" | "operator",
  ): Promise<Response> {
    const body = (await request.json()) as PutEnabledRequest;
    if (typeof body.enabled !== "boolean") {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "enabled must be a boolean",
        },
        { status: 400 },
      );
    }

    const now = Date.now();
    const existing = this.readDelegationConfigRow(logIdHex32);
    const webhookUrl = existing?.webhook_url ?? null;
    const createdAt = existing?.created_at ?? now;
    const userEnabledInt =
      authority === "user"
        ? body.enabled
          ? 1
          : 0
        : (existing?.user_enabled ?? 1);
    const operatorEnabledInt =
      authority === "operator"
        ? body.enabled
          ? 1
          : 0
        : (existing?.operator_enabled ?? 1);
    const legacyEnabledInt =
      userEnabledInt !== 0 && operatorEnabledInt !== 0 ? 1 : 0;

    this.ctx.storage.sql.exec(
      `INSERT INTO log_delegation_config
         (log_id_hex32, webhook_url, enabled, user_enabled, operator_enabled,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         user_enabled = excluded.user_enabled,
         operator_enabled = excluded.operator_enabled,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      logIdHex32,
      webhookUrl,
      legacyEnabledInt,
      userEnabledInt,
      operatorEnabledInt,
      createdAt,
      now,
    );

    const resp: EnabledResponse = {
      enabled: userEnabledInt !== 0 && operatorEnabledInt !== 0,
      userEnabled: userEnabledInt !== 0,
      operatorEnabled: operatorEnabledInt !== 0,
    };
    return Response.json(resp);
  }

  /** Public base URL for certificateSubmitUrl in webhook payloads. */
  private coordinatorPublicUrl(): string {
    return (
      this.env.COORDINATOR_PUBLIC_URL?.trim() ||
      "https://delegation-coordinator.example"
    );
  }

  /** Insert webhook_deliveries row and attempt first delivery. */
  private async enqueueWebhookDelivery(input: {
    logIdHex32: string;
    authLogIdHex32: string;
    mmrStart: number;
    mmrEnd: number;
    delegatedPublicKey: Uint8Array;
    delegatedPubkeyHash: string;
    requestedAt: number;
  }): Promise<void> {
    const config = this.readDelegationConfigRow(input.logIdHex32);
    if (!config?.webhook_url || !this.effectiveEnabled(config)) {
      return;
    }

    const event = await buildDelegationRequiredEvent({
      logIdHex32: input.logIdHex32,
      authLogIdHex32: input.authLogIdHex32,
      mmrStart: input.mmrStart,
      mmrEnd: input.mmrEnd,
      delegatedPublicKeyBase64: bytesToBase64(input.delegatedPublicKey),
      delegatedPubkeyHash: input.delegatedPubkeyHash,
      requestedAt: input.requestedAt,
      certificateSubmitUrl: certificateSubmitUrlFromEnv(
        this.coordinatorPublicUrl(),
      ),
    });
    const payloadJson = JSON.stringify(event);
    const now = Math.floor(Date.now() / 1000);

    this.ctx.storage.sql.exec(
      `INSERT INTO webhook_deliveries
         (request_key, log_id_hex32, webhook_url, payload_json, attempt,
          next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(request_key) DO UPDATE SET
         webhook_url = excluded.webhook_url,
         payload_json = excluded.payload_json,
         attempt = 0,
         next_attempt_at = excluded.next_attempt_at`,
      event.requestKey,
      input.logIdHex32,
      config.webhook_url,
      payloadJson,
      now,
      now,
    );

    await this.processWebhookDeliveryAttempt(event.requestKey);
  }

  /** POST webhook once; schedule retry or delete on outcome. */
  private async processWebhookDeliveryAttempt(
    requestKey: string,
  ): Promise<void> {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT request_key, webhook_url, payload_json, attempt
         FROM webhook_deliveries WHERE request_key = ?`,
        requestKey,
      ),
    ];
    if (rows.length === 0) return;

    const row = rows[0] as {
      request_key: string;
      webhook_url: string;
      payload_json: string;
      attempt: number;
    };

    const result = await deliverSignedWebhook(
      this.env,
      row.webhook_url,
      row.payload_json,
    );
    if (result.ok) {
      this.ctx.storage.sql.exec(
        `DELETE FROM webhook_deliveries WHERE request_key = ?`,
        requestKey,
      );
      this.scheduleNextWebhookAlarm();
      return;
    }

    const retry = parseRetryConfig(this.env);
    const nextAttempt = row.attempt + 1;
    if (nextAttempt > retry.retryLadder.length) {
      this.ctx.storage.sql.exec(
        `DELETE FROM webhook_deliveries WHERE request_key = ?`,
        requestKey,
      );
      this.scheduleNextWebhookAlarm();
      return;
    }

    const waitMs = computeRetryWaitMs(retry, nextAttempt - 1);
    const nextAt = Math.floor(Date.now() / 1000) + Math.ceil(waitMs / 1000);
    this.ctx.storage.sql.exec(
      `UPDATE webhook_deliveries
       SET attempt = ?, next_attempt_at = ?
       WHERE request_key = ?`,
      nextAttempt,
      nextAt,
      requestKey,
    );
    this.scheduleNextWebhookAlarm();
  }

  /** Set DO alarm to earliest webhook_deliveries.next_attempt_at. */
  private scheduleNextWebhookAlarm(): void {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT MIN(next_attempt_at) AS min_at FROM webhook_deliveries`,
      ),
    ];
    const minAt = (rows[0] as { min_at: number | null } | undefined)?.min_at;
    if (minAt == null) return;
    this.ctx.storage.setAlarm(minAt * 1000);
  }

  /** Process due webhook delivery retries. */
  async alarm(): Promise<void> {
    this.ensureSchema();
    const now = Math.floor(Date.now() / 1000);
    const due = [
      ...this.ctx.storage.sql.exec(
        `SELECT request_key FROM webhook_deliveries
         WHERE next_attempt_at <= ?`,
        now,
      ),
    ];
    for (const row of due) {
      await this.processWebhookDeliveryAttempt(
        (row as { request_key: string }).request_key,
      );
    }
    this.scheduleNextWebhookAlarm();
  }

  /**
   * Read stored certificate row (@internal — tests).
   *
   * @param logIdHex32 - Target log id.
   * @param certificateKey - Composite storage key.
   */
  getDelegationCertificateRecord(
    logIdHex32: string,
    certificateKey: string,
  ): DelegationCertificateRecord | null {
    this.ensureSchema();
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT certificate, issued_at, expires_at
       FROM delegation_certificates
       WHERE log_id_hex32 = ? AND certificate_key = ?`,
        logIdHex32,
        certificateKey,
      ),
    ];
    if (rows.length === 0) return null;
    const row = rows[0] as {
      certificate: ArrayBuffer;
      issued_at: number;
      expires_at: number;
    };
    return {
      logIdHex32,
      certificateKey,
      certificate: new Uint8Array(row.certificate),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
  }

  /** @deprecated use getDelegationCertificateRecord */
  getMaterialRecord(
    logIdHex32: string,
    materialKey: string,
  ): DelegationCertificateRecord | null {
    return this.getDelegationCertificateRecord(logIdHex32, materialKey);
  }

  /**
   * Dev/ops: wipe durable SQLite and re-run schema init.
   * The HTTP worker must only call this after checking NODE_ENV and reset token.
   */
  async devResetStorage(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.initialized = false;
    this.ensureSchema();
  }
}
