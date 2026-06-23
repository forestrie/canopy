import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/**
 * Single global DO for wallet-challenge nonce issuance and consumption.
 */
export class WalletChallengeNonceDO extends DurableObject<Env> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/issue") {
      return this.handleIssue(request);
    }
    if (request.method === "POST" && url.pathname === "/consume") {
      return this.handleConsume(request);
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private ensureSchema(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS wallet_challenge_nonces (
        nonce_id TEXT PRIMARY KEY,
        auth_log_id_hex32 TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.initialized = true;
  }

  private async handleIssue(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      authLogIdHex32: string;
      scopes: string[];
      expiresAt: number;
    };
    const nonce = crypto.randomUUID().replace(/-/g, "");
    this.ctx.storage.sql.exec(
      `INSERT INTO wallet_challenge_nonces
       (nonce_id, auth_log_id_hex32, scopes_json, expires_at, consumed)
       VALUES (?, ?, ?, ?, 0)`,
      nonce,
      body.authLogIdHex32,
      JSON.stringify(body.scopes),
      body.expiresAt,
    );
    this.pruneExpired(Date.now());
    return Response.json({ nonce });
  }

  private async handleConsume(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      nonce: string;
      authLogIdHex32: string;
      scopes: string[];
    };
    const now = Date.now();
    this.pruneExpired(now);

    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT auth_log_id_hex32, scopes_json, expires_at, consumed
         FROM wallet_challenge_nonces WHERE nonce_id = ?`,
        body.nonce,
      ),
    ];
    if (rows.length === 0) {
      return Response.json(
        { ok: false, reason: "unknown_nonce" },
        { status: 409 },
      );
    }
    const row = rows[0] as {
      auth_log_id_hex32: string;
      scopes_json: string;
      expires_at: number;
      consumed: number;
    };
    if (row.consumed !== 0) {
      return Response.json({ ok: false, reason: "consumed" }, { status: 409 });
    }
    if (row.expires_at < now) {
      return Response.json({ ok: false, reason: "expired" }, { status: 409 });
    }
    if (row.auth_log_id_hex32 !== body.authLogIdHex32) {
      return Response.json(
        { ok: false, reason: "auth_log_mismatch" },
        { status: 409 },
      );
    }
    const storedScopes = JSON.parse(row.scopes_json) as string[];
    const requested = [...body.scopes].sort().join(",");
    const stored = [...storedScopes].sort().join(",");
    if (requested !== stored) {
      return Response.json(
        { ok: false, reason: "scope_mismatch" },
        { status: 409 },
      );
    }

    this.ctx.storage.sql.exec(
      `UPDATE wallet_challenge_nonces SET consumed = 1 WHERE nonce_id = ?`,
      body.nonce,
    );
    return Response.json({ ok: true });
  }

  private pruneExpired(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM wallet_challenge_nonces WHERE expires_at < ? OR consumed = 1`,
      now - 60_000,
    );
  }
}
