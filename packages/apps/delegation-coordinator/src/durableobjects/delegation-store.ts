/**
 * DelegationStoreDO — sharded persistence for signing routes, material, and
 * pending delegation hints.
 */

import { DurableObject } from "cloudflare:workers";
import { decode, encode } from "cbor-x";
import type { Env } from "../env.js";
import { materialKeyFor, sha256Hex } from "../material-key.js";
import { hex32ToWireLogIdBytes, logIdWireBytesToHex32 } from "../log-id.js";
import type { PutPublicRootBody } from "../types/put-public-root-body.js";
import type { TrustRootResponseCbor } from "../types/trust-root-response.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
} from "../types/trust-root-response.js";
import type { PublicRootMaterial } from "../validate-byok-material.js";
import { base64ToBytes, bytesToBase64 } from "../encoding.js";
import type { DelegationIssueRequest } from "../types/delegation-issue-request.js";
import type { DelegationIssueResponse } from "../types/delegation-issue-response.js";
import type { MaterialRecord } from "../types/material-record.js";
import type { PendingEntry } from "../types/pending-entry.js";
import type { PendingHintRequest } from "../types/pending-hint-request.js";
import type { SigningRoute } from "../types/signing-route.js";
import type { SubmitMaterialRequest } from "../types/submit-material-request.js";
import type { PutWebhookRequest } from "../types/put-webhook-request.js";
import type { PutEnabledRequest } from "../types/put-enabled-request.js";
import type { WebhookConfigResponse } from "../types/webhook-config-response.js";
import type { EnabledResponse } from "../types/enabled-response.js";
import { delegationPendingResponse } from "../delegation-pending-response.js";
import {
  ByokMaterialValidationError,
  validateByokDelegationMaterial,
} from "../validate-byok-material.js";
import {
  buildDelegationRequiredEvent,
  materialSubmitUrlFromEnv,
} from "../webhook/build-delegation-required-event.js";
import { deliverSignedWebhook } from "../webhook/deliver-webhook.js";
import {
  computeRetryWaitMs,
  parseRetryConfig,
} from "../webhook/retry-config.js";

const PENDING_TTL_SECONDS = 60 * 60;
const PENDING_CAP_PER_LOG = 32;

export class DelegationStoreDO extends DurableObject<Env> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

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

      if (pathname === "/material" && method === "PUT") {
        return this.handlePutMaterial(request);
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

      const enabledMatch = /^\/enabled\/([0-9a-f]{32})$/.exec(pathname);
      if (enabledMatch) {
        const logIdHex32 = enabledMatch[1]!;
        if (method === "GET") {
          return this.handleGetEnabled(logIdHex32);
        }
        if (method === "PUT") {
          return this.handlePutEnabled(logIdHex32, request);
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

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
    throw new ByokMaterialValidationError(
      `unsupported stored public root alg ${row.alg}`,
    );
  }

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

  private handleGetPublicRoot(logIdHex32: string): Response {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT alg, x, y FROM public_roots WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];

    if (rows.length === 0) {
      const problem = encode({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "public root not uploaded for log",
      });
      const bytes =
        problem instanceof Uint8Array
          ? problem
          : new Uint8Array(problem as ArrayLike<number>);
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
      const problem = encode({
        type: "about:blank",
        title: "Internal error",
        status: 500,
        detail,
      });
      const bytes =
        problem instanceof Uint8Array
          ? problem
          : new Uint8Array(problem as ArrayLike<number>);
      return new Response(bytes, {
        status: 500,
        headers: { "Content-Type": "application/problem+cbor" },
      });
    }

    const encoded = encode(resp);
    const out =
      encoded instanceof Uint8Array
        ? encoded
        : new Uint8Array(encoded as ArrayLike<number>);
    return new Response(out, {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  }

  private async handlePutMaterial(request: Request): Promise<Response> {
    const body = (await request.json()) as SubmitMaterialRequest;
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
      await validateByokDelegationMaterial({
        logIdHex32,
        mmrStart: body.mmrStart,
        mmrEnd: body.mmrEnd,
        delegatedPublicKey,
        certificate,
        publicRoot: this.publicRootMaterialFromRow(rootRow),
        ks256RpcUrl: this.env.KS256_RPC_URL,
      });
    } catch (error) {
      const detail =
        error instanceof ByokMaterialValidationError
          ? error.message
          : error instanceof Error
            ? error.message
            : "invalid delegation material";
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

    const key = await materialKeyFor(
      body.mmrStart,
      body.mmrEnd,
      delegatedPublicKey,
    );

    this.ctx.storage.sql.exec(
      `INSERT INTO materials (log_id_hex32, material_key, certificate, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32, material_key) DO UPDATE SET
         certificate = excluded.certificate,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at`,
      logIdHex32,
      key,
      certificate,
      body.issuedAt,
      body.expiresAt,
    );

    const pubkeyHash = await sha256Hex(delegatedPublicKey);
    this.ctx.storage.sql.exec(
      `DELETE FROM pending
       WHERE log_id_hex32 = ? AND mmr_start = ? AND mmr_end = ? AND delegated_pubkey_hash = ?`,
      logIdHex32,
      body.mmrStart,
      body.mmrEnd,
      pubkeyHash,
    );

    return Response.json({ ok: true, materialKey: key });
  }

  private async handleIssue(request: Request): Promise<Response> {
    const buffer = await request.arrayBuffer();
    const req = decode(new Uint8Array(buffer)) as DelegationIssueRequest;

    const logIdHex32 = logIdWireBytesToHex32(req.logId);
    if (!this.isDelegationSurfacingEnabled(logIdHex32)) {
      return delegationPendingResponse(202);
    }

    const key = await materialKeyFor(
      req.mmrStart,
      req.mmrEnd,
      req.delegatedPublicKey,
    );

    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT certificate, issued_at, expires_at
       FROM materials
       WHERE log_id_hex32 = ? AND material_key = ?`,
        logIdHex32,
        key,
      ),
    ];

    if (rows.length === 0) {
      const pubkeyHash = await sha256Hex(req.delegatedPublicKey);
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
    };

    const certificateBytes = new Uint8Array(row.certificate);
    const resp: DelegationIssueResponse = {
      version: 1,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      certificate: certificateBytes,
    };

    const encoded = encode(resp);
    const out =
      encoded instanceof Uint8Array
        ? encoded
        : new Uint8Array(encoded as ArrayLike<number>);
    return new Response(out, {
      status: 200,
      headers: { "Content-Type": "application/cbor" },
    });
  }

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
           (SELECT enabled FROM log_delegation_config c
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

  /** Default true when no config row exists (same as webhook CRUD defaults). */
  private isDelegationSurfacingEnabled(logIdHex32: string): boolean {
    const row = this.readDelegationConfigRow(logIdHex32);
    if (!row) return true;
    return row.enabled !== 0;
  }

  private readDelegationConfigRow(logIdHex32: string): {
    webhook_url: string | null;
    enabled: number;
    created_at: number;
    updated_at: number;
  } | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT webhook_url, enabled, created_at, updated_at
         FROM log_delegation_config WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    if (rows.length === 0) return null;
    return rows[0] as {
      webhook_url: string | null;
      enabled: number;
      created_at: number;
      updated_at: number;
    };
  }

  private webhookConfigResponseFromRow(row: {
    webhook_url: string | null;
    enabled: number;
    created_at: number;
    updated_at: number;
  }): WebhookConfigResponse {
    const resp: WebhookConfigResponse = {
      enabled: row.enabled !== 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.webhook_url) {
      resp.webhookUrl = row.webhook_url;
    }
    return resp;
  }

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
    const enabled = existing?.enabled ?? 1;
    const createdAt = existing?.created_at ?? now;

    this.ctx.storage.sql.exec(
      `INSERT INTO log_delegation_config
         (log_id_hex32, webhook_url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         webhook_url = excluded.webhook_url,
         updated_at = excluded.updated_at`,
      logIdHex32,
      body.url,
      enabled,
      createdAt,
      now,
    );

    const row = this.readDelegationConfigRow(logIdHex32);
    return Response.json(
      row ? this.webhookConfigResponseFromRow(row) : { ok: true },
    );
  }

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

  private handleGetEnabled(logIdHex32: string): Response {
    const row = this.readDelegationConfigRow(logIdHex32);
    if (!row) {
      return Response.json(
        { type: "about:blank", title: "Not Found", status: 404 },
        { status: 404 },
      );
    }
    const resp: EnabledResponse = { enabled: row.enabled !== 0 };
    return Response.json(resp);
  }

  private async handlePutEnabled(
    logIdHex32: string,
    request: Request,
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
    const enabledInt = body.enabled ? 1 : 0;

    this.ctx.storage.sql.exec(
      `INSERT INTO log_delegation_config
         (log_id_hex32, webhook_url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      logIdHex32,
      webhookUrl,
      enabledInt,
      createdAt,
      now,
    );

    const resp: EnabledResponse = { enabled: body.enabled };
    return Response.json(resp);
  }

  private coordinatorPublicUrl(): string {
    return (
      this.env.COORDINATOR_PUBLIC_URL?.trim() ||
      "https://delegation-coordinator.example"
    );
  }

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
    if (!config?.webhook_url || config.enabled === 0) {
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
      materialSubmitUrl: materialSubmitUrlFromEnv(this.coordinatorPublicUrl()),
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

  /** @internal Exported for tests */
  getMaterialRecord(
    logIdHex32: string,
    materialKey: string,
  ): MaterialRecord | null {
    this.ensureSchema();
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT certificate, issued_at, expires_at
       FROM materials WHERE log_id_hex32 = ? AND material_key = ?`,
        logIdHex32,
        materialKey,
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
      materialKey,
      certificate: new Uint8Array(row.certificate),
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    };
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
