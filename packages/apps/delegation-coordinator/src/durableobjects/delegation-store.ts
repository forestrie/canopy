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
import { base64ToBytes, bytesToBase64 } from "../encoding.js";
import type { DelegationIssueRequest } from "../types/delegation-issue-request.js";
import type { DelegationIssueResponse } from "../types/delegation-issue-response.js";
import type { MaterialRecord } from "../types/material-record.js";
import type { PendingEntry } from "../types/pending-entry.js";
import type { PendingHintRequest } from "../types/pending-hint-request.js";
import type { SigningRoute } from "../types/signing-route.js";
import type { SubmitMaterialRequest } from "../types/submit-material-request.js";
import { delegationPendingResponse } from "../delegation-pending-response.js";
import {
  ByokMaterialValidationError,
  validateByokDelegationMaterial,
} from "../validate-byok-material.js";

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
    if (body.alg !== "ES256") {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "alg must be ES256",
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

    const resp: TrustRootResponseCbor = {
      logId: hex32ToWireLogIdBytes(logIdHex32),
      alg: row.alg,
      x: new Uint8Array(row.x),
      y: new Uint8Array(row.y),
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
        publicRoot: {
          alg: rootRow.alg,
          x: new Uint8Array(rootRow.x),
          y: new Uint8Array(rootRow.y),
        },
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
}
