/**
 * DelegationStoreDO — sharded persistence for signing routes, material, and
 * pending delegation hints.
 */

import { DurableObject } from "cloudflare:workers";
import { decode, encode } from "cbor-x";
import type { Env } from "../env.js";
import { materialKeyFor, sha256Hex } from "../material-key.js";
import { logIdWireBytesToHex32 } from "../log-id.js";
import type { DelegationIssueRequest } from "../types/delegation-issue-request.js";
import type { DelegationIssueResponse } from "../types/delegation-issue-response.js";
import type { MaterialRecord } from "../types/material-record.js";
import type { PendingEntry } from "../types/pending-entry.js";
import type { PendingHintRequest } from "../types/pending-hint-request.js";
import type { SigningRoute } from "../types/signing-route.js";
import type { SubmitMaterialRequest } from "../types/submit-material-request.js";
import { base64ToBytes } from "../encoding.js";

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

      if (pathname === "/material" && method === "PUT") {
        return this.handlePutMaterial(request);
      }

      if (pathname === "/issue" && method === "POST") {
        return this.handleIssue(request);
      }

      if (pathname === "/pending" && method === "GET") {
        return this.handleGetPending(url);
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
        requested_at INTEGER NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_pending_auth_log
      ON pending (auth_log_id_hex32, requested_at DESC)
    `);

    this.initialized = true;
  }

  private handleGetSigningRoute(logIdHex32: string): Response {
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT mode, inherits_from, issuer_token FROM signing_routes WHERE log_id_hex32 = ?`,
      logIdHex32,
    )];

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

  private async handlePutMaterial(request: Request): Promise<Response> {
    const body = (await request.json()) as SubmitMaterialRequest;
    const logIdHex32 = body.logId;
    const delegatedPublicKey = base64ToBytes(body.delegatedPublicKey);
    const certificate = base64ToBytes(body.certificate);
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

    const rows = [...this.ctx.storage.sql.exec(
      `SELECT certificate, issued_at, expires_at
       FROM materials
       WHERE log_id_hex32 = ? AND material_key = ?`,
      logIdHex32,
      key,
    )];

    if (rows.length === 0) {
      const pubkeyHash = await sha256Hex(req.delegatedPublicKey);
      const now = Math.floor(Date.now() / 1000);
      const id = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO pending
         (id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end, delegated_pubkey_hash, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        logIdHex32,
        logIdHex32,
        req.mmrStart,
        req.mmrEnd,
        pubkeyHash,
        now,
      );

      const problem = encode({
        type: "about:blank",
        title: "Service Unavailable",
        status: 503,
        detail: "delegation material not found for requested range and key",
      });
      const bytes =
        problem instanceof Uint8Array
          ? problem
          : new Uint8Array(problem as ArrayLike<number>);
      return new Response(bytes, {
        status: 503,
        headers: { "Content-Type": "application/problem+cbor" },
      });
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

    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Math.min(Math.max(1, limitRaw), 500);

    const rows = [...this.ctx.storage.sql.exec(
      `SELECT id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end,
              delegated_pubkey_hash, requested_at
       FROM pending
       WHERE auth_log_id_hex32 = ?
       ORDER BY requested_at DESC
       LIMIT ? OFFSET ?`,
      authLogId,
      limit,
      offset,
    )];

    const entries: PendingEntry[] = rows.map((row) => {
      const r = row as {
        id: string;
        auth_log_id_hex32: string;
        log_id_hex32: string;
        mmr_start: number;
        mmr_end: number;
        delegated_pubkey_hash: string;
        requested_at: number;
      };
      return {
        id: r.id,
        authLogIdHex32: r.auth_log_id_hex32,
        logIdHex32: r.log_id_hex32,
        mmrStart: r.mmr_start,
        mmrEnd: r.mmr_end,
        delegatedPublicKeyHash: r.delegated_pubkey_hash,
        requestedAt: r.requested_at,
      };
    });

    return Response.json({ entries, offset, limit });
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
       (id, auth_log_id_hex32, log_id_hex32, mmr_start, mmr_end, delegated_pubkey_hash, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      authLogIdHex32,
      logIdHex32,
      body.mmrStart,
      body.mmrEnd,
      pubkeyHash,
      now,
    );

    return Response.json({ ok: true, id });
  }

  /** @internal Exported for tests */
  getMaterialRecord(
    logIdHex32: string,
    materialKey: string,
  ): MaterialRecord | null {
    this.ensureSchema();
    const rows = [...this.ctx.storage.sql.exec(
      `SELECT certificate, issued_at, expires_at
       FROM materials WHERE log_id_hex32 = ? AND material_key = ?`,
      logIdHex32,
      materialKey,
    )];
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
