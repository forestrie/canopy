/**
 * Global Durable Object for wallet-challenge nonce issuance and consumption.
 *
 * Single instance per worker (`wallet-challenge-nonce` name). Upstream:
 * {@link issueWalletChallengeNonce} from POST /api/auth/challenge. Downstream:
 * {@link consumeWalletChallengeNonce} at POST /api/auth/session before minting
 * HMAC session tokens.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

/** SQLite-backed one-time nonces for wcc-1 challenges. */
export class WalletChallengeNonceDO extends DurableObject<Env> {
  private initialized = false;

  /** Bind Cloudflare DO state and worker env. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  /** Route /issue and /consume internal POST paths. */
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

  /** Create wallet_challenge_nonces table if missing. */
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

  /** POST /issue — insert nonce bound to auth log and scopes. */
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

  /** POST /consume — mark nonce used when binding matches. */
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

  /** Delete expired and recently consumed nonce rows. */
  private pruneExpired(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM wallet_challenge_nonces WHERE expires_at < ? OR consumed = 1`,
      now - 60_000,
    );
  }
}
