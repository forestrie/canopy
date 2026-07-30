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
import type {
  InstanceWebhookResponse,
  PutInstanceWebhookRequest,
} from "../types/instance-webhook.js";
import {
  isUnivocityInstanceId,
  parseUnivocityInstanceId,
} from "@canopy/univocity-instance-id";
import { univocityInstanceIdFromLegacyInstanceKey } from "../legacy-instance-id.js";
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
import { swallowingKs256VerifyHooks } from "../ks256-rpc-verify-hooks.js";
import {
  chainIdFromUnivocityInstanceId,
  strictHooksForChain,
} from "../chain-rpc-selection.js";
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

/** `log_delegation_config.webhook_source` for a URL copied from the instance. */
const WEBHOOK_SOURCE_INSTANCE = "instance";

/** `log_delegation_config.webhook_source` for a URL set directly on the log. */
const WEBHOOK_SOURCE_LOG = "log";

/** Pending row TTL before prune (seconds). */
const PENDING_TTL_SECONDS = 60 * 60;

/** Max pending hints retained per target log id. */
const PENDING_CAP_PER_LOG = 32;

/**
 * Suggested TTL a signer applies when pre-signing an advance delegation to the
 * standing key (C3) — the advance certificate's lifetime.
 *
 * This MUST comfortably exceed the sealer's requested lease TTL (arbor
 * `defaultDelegationTTL` = 60 min), because the sealer's lease verify rejects a
 * certificate that does not still have ~that long remaining *at seal time*
 * (`cert.expiresAt >= now + RequestedTTLSeconds - 2min`). An advance cert is
 * pre-signed BEFORE the write it will seal — often minutes to hours ahead — so
 * a TTL equal to the sealer's 60-min window leaves only a ~2-minute delegate→seal
 * budget and any longer lead time fails "delegation lease expires too soon for
 * requested ttl". 6 h gives ample pre-sign lead while staying well under the
 * standing-key rotation window (DELEGATE_KEY_TTL, 720 h). See devdocs
 * plan-2607-24 / ADR-0050.
 */
const STANDING_DELEGATION_TTL_SECONDS = 6 * 60 * 60;

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

      if (pathname === "/active" && method === "GET") {
        return this.handleGetActive(url);
      }

      if (pathname === "/pending-delegation" && method === "GET") {
        return this.handleGetPendingDelegation(url);
      }

      if (pathname === "/delegation" && method === "GET") {
        return this.handleGetDelegation(url);
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

      const instanceWebhookMatch = /^\/instance-webhook\/(.+)$/.exec(pathname);
      if (instanceWebhookMatch) {
        let univocityInstanceId: string;
        try {
          univocityInstanceId = parseUnivocityInstanceId(
            decodeURIComponent(instanceWebhookMatch[1]!),
          );
        } catch (error) {
          return Response.json(
            {
              type: "about:blank",
              title: "Invalid request",
              status: 400,
              detail:
                error instanceof Error
                  ? error.message
                  : "Invalid univocityInstanceId",
            },
            { status: 400 },
          );
        }
        if (method === "GET") {
          return this.handleGetInstanceWebhook(univocityInstanceId);
        }
        if (method === "PUT") {
          return this.handlePutInstanceWebhook(univocityInstanceId, request);
        }
        if (method === "DELETE") {
          return this.handleDeleteInstanceWebhook(univocityInstanceId);
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
        not_after INTEGER NOT NULL,
        voucher BLOB
      )
    `);
    this.ensureDelegateKeyVoucherColumn();

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
        univocity_instance_id TEXT,
        webhook_source TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        user_enabled INTEGER NOT NULL DEFAULT 1,
        operator_enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.ensureEnabledAuthorityColumns();
    this.ensureLogConfigUnivocityInstanceIdColumns();
    this.ensurePublicRootChainColumn();

    // Instance-level webhooks (FOR-468). Per-univocity-instance, replicated to
    // every shard — like delegate_keys — so a log's shard can copy the URL into
    // its own config row at registration without a cross-shard hop on the
    // delegation request path. Re-pointing fans the update out to all shards.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS instance_webhooks (
        univocity_instance_id TEXT PRIMARY KEY,
        webhook_url TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.ensureInstanceWebhooksUnivocityInstanceIdColumn();
    this.rewriteLegacyUnivocityInstanceIds();

    this.ctx.storage.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_log_delegation_config_instance
      ON log_delegation_config (univocity_instance_id)
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

  /** Add the custodian voucher column on legacy delegate_keys tables (FOR-390 phase H). */
  private ensureDelegateKeyVoucherColumn(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT voucher FROM delegate_keys LIMIT 0`,
        ),
      ];
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE delegate_keys ADD COLUMN voucher BLOB`,
      );
    }
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

  /**
   * Bring pre-existing log_delegation_config tables to the current instance
   * columns. Fresh databases get `univocity_instance_id` / `webhook_source`
   * from the base CREATE TABLE (FOR-468 review L1); legacy tables either
   * rename `instance_key` in place (ADR-0059 D1) or, when they pre-date
   * FOR-468 entirely, add both columns.
   *
   * `webhook_source` records whether `webhook_url` was set directly on the log
   * (`log`) or copied from its instance (`instance`). Only copies are rewritten
   * by an instance re-point, so an explicit per-log override survives one.
   * Existing rows pre-date instances and keep a NULL source, which reads as an
   * explicit per-log URL.
   */
  /**
   * Nullable `chain_id` on public_roots (plan-2607-46 slice 03): the log's
   * EIP-155 chain, carried on the public-root PUT so ERC-1271 verification
   * can select chain-scoped RPC without depending on the best-effort
   * instance-binding write. Legacy rows stay NULL and fall back to
   * `log_delegation_config.univocity_instance_id`.
   */
  private ensurePublicRootChainColumn(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT chain_id FROM public_roots LIMIT 0`,
        ),
      ];
      return;
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE public_roots ADD COLUMN chain_id TEXT`,
      );
    }
  }

  private ensureLogConfigUnivocityInstanceIdColumns(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT univocity_instance_id FROM log_delegation_config LIMIT 0`,
        ),
      ];
      return;
    } catch {
      // legacy table; renamed or extended below
    }
    let hasLegacyColumn = true;
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT instance_key FROM log_delegation_config LIMIT 0`,
        ),
      ];
    } catch {
      hasLegacyColumn = false;
    }
    if (hasLegacyColumn) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE log_delegation_config
         RENAME COLUMN instance_key TO univocity_instance_id`,
      );
    } else {
      this.ctx.storage.sql.exec(
        `ALTER TABLE log_delegation_config ADD COLUMN univocity_instance_id TEXT`,
      );
      this.ctx.storage.sql.exec(
        `ALTER TABLE log_delegation_config ADD COLUMN webhook_source TEXT`,
      );
    }
  }

  /** Rename instance_webhooks.instance_key on legacy databases (ADR-0059 D1). */
  private ensureInstanceWebhooksUnivocityInstanceIdColumn(): void {
    try {
      [
        ...this.ctx.storage.sql.exec(
          `SELECT univocity_instance_id FROM instance_webhooks LIMIT 0`,
        ),
      ];
    } catch {
      this.ctx.storage.sql.exec(
        `ALTER TABLE instance_webhooks
         RENAME COLUMN instance_key TO univocity_instance_id`,
      );
    }
  }

  /**
   * Rewrite stored legacy-form values to canonical CAIP-10 (ADR-0059 D6).
   * Runs every boot, so per-row idempotency is not enough: the method must
   * CONVERGE over every reachable data state of each table. Rollout version
   * skew — our own deploy-window shims writing canonical values ahead of
   * this migration — can leave a legacy-keyed and a canonical-keyed
   * `instance_webhooks` row for the same instance, so rewriting that primary
   * key must handle target-exists: the legacy row is deleted and the
   * canonical one kept. Keep-canonical is provable, not a judgment call:
   * pre-cutover code never generated canonical values, so a canonical-keyed
   * row is post-cutover and strictly newer than any legacy twin. Every other
   * data problem degrades to a warning — this runs on the constructor path,
   * where a throw is a crash loop on every shard, and no binding is silently
   * dropped.
   */
  private rewriteLegacyUnivocityInstanceIds(): void {
    for (const { table, rowKey, keyIsUnique } of [
      // univocity_instance_id is not unique in log_delegation_config; no
      // collision handling needed there, only the non-fatal wrapper.
      {
        table: "log_delegation_config",
        rowKey: "log_id_hex32",
        keyIsUnique: false,
      },
      {
        table: "instance_webhooks",
        rowKey: "univocity_instance_id",
        keyIsUnique: true,
      },
    ]) {
      const rows = [
        ...this.ctx.storage.sql.exec(
          `SELECT ${rowKey} AS row_key, univocity_instance_id AS id
           FROM ${table}
           WHERE univocity_instance_id IS NOT NULL`,
        ),
      ] as { row_key: string; id: string }[];
      for (const row of rows) {
        try {
          if (isUnivocityInstanceId(row.id)) continue;
          const canonical = univocityInstanceIdFromLegacyInstanceKey(row.id);
          if (!canonical) {
            console.warn(
              `univocity_instance_id migration: ${table} value "${row.id}" is neither canonical nor legacy; left unchanged`,
            );
            continue;
          }
          if (keyIsUnique) {
            const collides =
              [
                ...this.ctx.storage.sql.exec(
                  `SELECT 1 FROM ${table} WHERE ${rowKey} = ?`,
                  canonical,
                ),
              ].length > 0;
            if (collides) {
              this.ctx.storage.sql.exec(
                `DELETE FROM ${table} WHERE ${rowKey} = ?`,
                row.row_key,
              );
              console.warn(
                `univocity_instance_id migration: ${table} legacy row "${row.id}" collides with existing canonical "${canonical}"; legacy row deleted, canonical kept`,
              );
              continue;
            }
          }
          this.ctx.storage.sql.exec(
            `UPDATE ${table} SET univocity_instance_id = ? WHERE ${rowKey} = ?`,
            canonical,
            row.row_key,
          );
        } catch (error) {
          console.warn(
            `univocity_instance_id migration: ${table} row "${row.row_key}" not rewritten: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
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

    // H4 genesis PUSH (FOR-390 phase H): the moment a signing route is known,
    // if a standing delegate key is already registered, fire delegation.required
    // for it so a hands-off (Mode C) signer auto-pre-delegates and the first
    // seal is a coverage hit. enqueueWebhookDelivery no-ops for routes without
    // a webhook and for wallet-mode routes (which pull C3 instead).
    // Idempotent by request_key.
    this.ctx.waitUntil(
      this.enqueueStandingDelegationWebhook(
        logIdHex32,
        Math.floor(Date.now() / 1000),
      ),
    );

    return Response.json({ ok: true });
  }

  /**
   * Fire a delegation.required webhook for the log's current standing delegate
   * key over the window-less [0,0] range (H4 genesis PUSH). No-op when no
   * standing key is registered yet — the registration-completion trigger (a
   * bounded scan of signing routes still awaiting a standing delegation) covers
   * the cold-start ordering where the route precedes the sealer's registration.
   */
  private async enqueueStandingDelegationWebhook(
    logIdHex32: string,
    nowSeconds: number,
  ): Promise<void> {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT public_key FROM delegate_keys
          WHERE not_after > ?
          ORDER BY epoch DESC, not_after DESC
          LIMIT 1`,
        nowSeconds,
      ),
    ];
    if (rows.length === 0) return;
    const publicKey = new Uint8Array(
      (rows[0] as { public_key: ArrayBuffer }).public_key,
    );
    const delegatedPubkeyHash = await sha256Hex(publicKey);
    await this.enqueueWebhookDelivery({
      logIdHex32,
      authLogIdHex32: logIdHex32,
      mmrStart: 0,
      mmrEnd: 0,
      delegatedPublicKey: publicKey,
      delegatedPubkeyHash,
      requestedAt: nowSeconds,
    });
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

    const chainIdRaw = body.chainBinding?.chainId?.trim();
    if (chainIdRaw !== undefined && !/^\d+$/.test(chainIdRaw)) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "chainBinding.chainId must be a decimal EIP-155 id",
        },
        { status: 400 },
      );
    }
    const chainId = chainIdRaw ?? null;

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
        `INSERT INTO public_roots (log_id_hex32, alg, x, y, chain_id, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(log_id_hex32) DO UPDATE SET
           alg = excluded.alg,
           x = excluded.x,
           y = excluded.y,
           chain_id = COALESCE(excluded.chain_id, public_roots.chain_id),
           uploaded_at = excluded.uploaded_at`,
        logIdHex32,
        body.alg,
        x,
        y,
        chainId,
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
      `INSERT INTO public_roots (log_id_hex32, alg, x, y, chain_id, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         alg = excluded.alg,
         x = excluded.x,
         y = excluded.y,
         chain_id = COALESCE(excluded.chain_id, public_roots.chain_id),
         uploaded_at = excluded.uploaded_at`,
      logIdHex32,
      String(algInt),
      key,
      new Uint8Array(0),
      chainId,
      Date.now(),
    );

    return Response.json({ ok: true });
  }

  /** Chain id from the log's instance binding row, or null. */
  private chainIdFromInstanceBinding(logIdHex32: string): string | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT univocity_instance_id FROM log_delegation_config WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    const instanceId = (
      rows[0] as { univocity_instance_id: string | null } | undefined
    )?.univocity_instance_id;
    return instanceId ? chainIdFromUnivocityInstanceId(instanceId) : null;
  }

  /**
   * The log's EIP-155 chain for ERC-1271 RPC selection (plan-2607-46 slice
   * 03): public_roots.chain_id first (written by the genesis registration
   * PUT), instance binding as fallback for legacy rows; null = unresolvable
   * — contract-root verification then fails closed.
   */
  private resolveLogChainId(logIdHex32: string): string | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT chain_id FROM public_roots WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    const stored = (rows[0] as { chain_id: string | null } | undefined)
      ?.chain_id;
    return stored ?? this.chainIdFromInstanceBinding(logIdHex32);
  }

  /**
   * Swallowing KS256 hooks scoped to the log's chain, or undefined when the
   * chain is unresolvable or has no RPC configured — the KS256 verify then
   * runs EOA-recovery-only and a contract root fails closed.
   */
  private ks256HooksForLog(
    logIdHex32: string,
  ): import("@forestrie/delegation-cose").Ks256VerifyHooks | undefined {
    const chainId = this.resolveLogChainId(logIdHex32);
    if (!chainId) return undefined;
    const strict = strictHooksForChain(this.env, chainId);
    if (!strict) return undefined;
    return swallowingKs256VerifyHooks(strict);
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

  /**
   * Trust-root answers are never cached (FOR-302, ADR-0057).
   *
   * A 404 here means "this log's root key is not stored", which a caller cannot
   * distinguish from "not yet propagated" — and callers convert it into a
   * terminal 403. Caching it would freeze a transient answer into a durable
   * rejection of valid receipts. The directive is set here, at the point the
   * response is built, so the edge handler can forward the stub response
   * untouched.
   */

  /** GET /public-root/{logIdHex32} — CBOR trust-root response. */
  private handleGetPublicRoot(logIdHex32: string): Response {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT alg, x, y, chain_id FROM public_roots WHERE log_id_hex32 = ?`,
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
        headers: {
          "Content-Type": "application/problem+cbor",
          "Cache-Control": "no-store",
        },
      });
    }

    const row = rows[0] as {
      alg: string;
      x: ArrayBuffer;
      y: ArrayBuffer;
      chain_id: string | null;
    };

    let resp: TrustRootResponseCbor;
    try {
      resp = this.trustRootCborFromRow(logIdHex32, row);
      const chainId =
        row.chain_id ?? this.chainIdFromInstanceBinding(logIdHex32);
      if (chainId) resp.chainId = chainId;
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
        headers: {
          "Content-Type": "application/problem+cbor",
          "Cache-Control": "no-store",
        },
      });
    }

    const out = encodeCbor(resp);
    return new Response(out, {
      status: 200,
      headers: {
        "Content-Type": "application/cbor",
        "Cache-Control": "no-store",
      },
    });
  }

  /** PUT /certificate — validate and persist delegation certificate. */
  private async handlePutCertificate(request: Request): Promise<Response> {
    const body = (await request.json()) as SubmitDelegationCertificateRequest;
    const logIdHex32 = body.logId;
    const delegatedPublicKey = base64ToBytes(body.delegatedPublicKey);
    const certificate = base64ToBytes(body.certificate);
    const pubkeyHash = await sha256Hex(delegatedPublicKey);
    const nowSeconds = Math.floor(Date.now() / 1000);
    // The opaque key this submission upserts (range + key). Used to exclude the
    // row an idempotent re-submit/refresh updates from the staleness check.
    const submitKey = await certificateKeyFor(
      body.mmrStart,
      body.mmrEnd,
      delegatedPublicKey,
    );

    // C5 (FOR-390 phase C-2): uniform validation + staleness.
    // An "advance" certificate is one bound to a registered standing delegate
    // key; it MUST carry the compact on-chain signature, else coverage
    // retrieval would later serve a certificate the publisher cannot publish
    // (review V3). Demand/BYOK submissions keep today's optionality.
    const isAdvance =
      [
        ...this.ctx.storage.sql.exec(
          `SELECT 1 FROM delegate_keys WHERE pubkey_hash = ? AND not_after > ?`,
          pubkeyHash,
          nowSeconds,
        ),
      ].length > 0;
    if (isAdvance && !body.onchainSignature) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail:
            "advance delegation certificate (bound to a registered delegate key) requires onchainSignature",
        },
        { status: 400 },
      );
    }
    // Reject stale submissions: already-expiring, or superseded by an existing
    // certificate for the same (logId, key) that is at least as wide and lives
    // at least as long. Overlapping ranges are otherwise accepted (ADR-0050).
    if (body.expiresAt <= nowSeconds + 60) {
      return Response.json(
        {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: `delegation certificate is stale: expiresAt=${body.expiresAt} is at or past now+60`,
        },
        { status: 409 },
      );
    }
    const superseding = [
      ...this.ctx.storage.sql.exec(
        `SELECT mmr_end, expires_at FROM delegation_certificates
          WHERE log_id_hex32 = ? AND delegated_pubkey_hash = ?
            AND certificate_key != ?
            AND mmr_end >= ? AND expires_at >= ?
          LIMIT 1`,
        logIdHex32,
        pubkeyHash,
        submitKey,
        body.mmrEnd,
        body.expiresAt,
      ),
    ];
    if (superseding.length > 0) {
      const s = superseding[0] as { mmr_end: number; expires_at: number };
      return Response.json(
        {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: `delegation certificate is stale: superseded by mmrEnd=${s.mmr_end} expiresAt=${s.expires_at}`,
        },
        { status: 409 },
      );
    }

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
        ks256Hooks: this.ks256HooksForLog(logIdHex32),
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
        ok = await verifyOnchainDelegationSignatureKs256(
          scope,
          signature,
          root.key,
          this.ks256HooksForLog(logIdHex32),
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

    const key = submitKey;

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

    // C5: satisfy every pending demand for this key whose window the accepted
    // certificate now covers (not just the exact window).
    this.ctx.storage.sql.exec(
      `DELETE FROM pending
       WHERE log_id_hex32 = ? AND delegated_pubkey_hash = ?
         AND mmr_start >= ? AND mmr_end <= ?`,
      logIdHex32,
      pubkeyHash,
      body.mmrStart,
      body.mmrEnd,
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

      // H2 membership (FOR-390 phase H): when enforcement is on, only a
      // registered standing delegate key may create a pending demand + signer
      // webhook. A compromised COORDINATOR_APP_TOKEN can then at most request
      // the real sealer's registered key (which it does not control) — never
      // inject an attacker key. Gated so epoch-0 ephemeral sealers are
      // unaffected until enablement.
      if (this.env.ENFORCE_DELEGATE_KEY_MEMBERSHIP === "true") {
        const registered =
          [
            ...this.ctx.storage.sql.exec(
              `SELECT 1 FROM delegate_keys WHERE pubkey_hash = ? AND not_after > ?`,
              reqKeyHash,
              nowSeconds,
            ),
          ].length > 0;
        if (!registered) {
          // No pending, no webhook: nothing unregistered reaches a signer.
          return delegationPendingResponse(202);
        }
      }

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

  /**
   * GET /active?threshold=&after=&limit= — one keyset page of logs in this
   * shard holding a delegation cert whose `expires_at > threshold` (i.e. active
   * or recently expired, per the sealer's grace window). Backs the sealer's
   * level-triggered resync (plan-2607-04): the resync compares each returned
   * log's massif head against its checkpoint in R2 and re-drives any unsealed
   * head. Keyset-paged by `log_id_hex32` so the scan is index-only over
   * {@link idx_delegation_certificates_coverage} `(log_id_hex32, expires_at,
   * mmr_start, mmr_end)` and stable across concurrent writes.
   *
   * Administratively disabled logs (user or operator kill-switch in
   * log_delegation_config) are excluded, matching handleGetPending — the sealer
   * resync must not re-drive seals for a disabled log.
   *
   * A log may hold several certs (distinct coverage windows); collapse to one
   * row per log with the furthest expiry and the union coverage range
   * (`MIN(mmr_start)`..`MAX(mmr_end)`). The sealer uses `mmrEnd` — the furthest
   * authorized MMR index — to hint how far the log should be sealed, avoiding a
   * massif read when the latest checkpoint already covers it. `nextKey` is the
   * last `log_id_hex32` returned, or null when this shard is exhausted (fewer
   * than `limit` rows). The worker owns cross-shard fan-out.
   */
  private handleGetActive(url: URL): Response {
    const threshold = Math.floor(
      Number(url.searchParams.get("threshold") ?? "0"),
    );
    const after = url.searchParams.get("after") ?? "";
    const limitRaw = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Math.min(Math.max(1, limitRaw), 500);

    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT log_id_hex32,
                MAX(expires_at) AS expires_at,
                MIN(mmr_start)  AS mmr_start,
                MAX(mmr_end)    AS mmr_end
         FROM delegation_certificates
         WHERE expires_at > ?
           AND log_id_hex32 > ?
           AND COALESCE(
             (SELECT (user_enabled != 0 AND operator_enabled != 0)
              FROM log_delegation_config c
              WHERE c.log_id_hex32 = delegation_certificates.log_id_hex32),
             1
           ) = 1
         GROUP BY log_id_hex32
         ORDER BY log_id_hex32
         LIMIT ?`,
        threshold,
        after,
        limit,
      ),
    ];

    const logs = rows.map((row) => {
      const r = row as {
        log_id_hex32: string;
        expires_at: number;
        mmr_start: number | null;
        mmr_end: number | null;
      };
      return {
        logIdHex32: r.log_id_hex32,
        expiresAt: r.expires_at,
        mmrStart: r.mmr_start,
        mmrEnd: r.mmr_end,
      };
    });

    const nextKey =
      logs.length < limit ? null : logs[logs.length - 1]!.logIdHex32;

    return Response.json({ logs, nextKey });
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

    // C3 (FOR-390 phase C-2): uniform entries — append the window-less standing
    // delegate-key entry so a signer can pre-delegate the moment the logId is
    // known (no demand needed). Present only when the log can actually be
    // delegated: a public root is registered and the sealer has a live standing
    // key. Old readers ignore the window-less entry.
    const standing = this.standingDelegationEntry(logIdHex32, now);
    const allEntries: Array<
      | PendingEntry
      | {
          delegatedPublicKey: string;
          suggestedTtlSeconds: number;
          sealerId?: string;
          epoch?: number;
          voucher?: string;
        }
    > = standing ? [...entries, standing] : entries;

    return Response.json({ entries: allEntries, limit: PENDING_CAP_PER_LOG });
  }

  /**
   * The window-less standing delegate-key entry for a log (C3), or null when
   * the log has no registered public root or no live standing delegate key.
   * Offers the newest (highest-epoch, unexpired) registered key.
   */
  private standingDelegationEntry(
    logIdHex32: string,
    nowSeconds: number,
  ): {
    delegatedPublicKey: string;
    suggestedTtlSeconds: number;
    sealerId?: string;
    epoch?: number;
    voucher?: string;
  } | null {
    const hasRoot =
      [
        ...this.ctx.storage.sql.exec(
          `SELECT 1 FROM public_roots WHERE log_id_hex32 = ?`,
          logIdHex32,
        ),
      ].length > 0;
    if (!hasRoot) return null;

    // Offer the sealer's current key — highest epoch, newest expiry as a
    // deterministic tie-break. (Per-log sealer assignment is future work; the
    // single-sealer-per-lane model makes "newest key" unambiguous today.)
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT public_key, sealer_id, epoch, voucher FROM delegate_keys
          WHERE not_after > ?
          ORDER BY epoch DESC, not_after DESC
          LIMIT 1`,
        nowSeconds,
      ),
    ];
    if (rows.length === 0) return null;

    const row = rows[0] as {
      public_key: ArrayBuffer;
      sealer_id: string;
      epoch: number;
      voucher: ArrayBuffer | null;
    };
    const publicKey = new Uint8Array(row.public_key);
    // H3 (FOR-390 phase H): advertise the custodian voucher (and the sealerId +
    // epoch it attests) so the signer/kit can verify the key's provenance
    // against the pinned registrar key before binding. Post-H1 registrations
    // always carry a voucher; a legacy voucher-less row simply omits it (the
    // kit then refuses to bind, which is correct).
    return {
      delegatedPublicKey: bytesToBase64(publicKey),
      suggestedTtlSeconds: STANDING_DELEGATION_TTL_SECONDS,
      sealerId: row.sealer_id,
      epoch: row.epoch,
      ...(row.voucher
        ? { voucher: bytesToBase64(new Uint8Array(row.voucher)) }
        : {}),
    };
  }

  /**
   * GET /delegation?logId= — public read of the current certificate (C2):
   * newest unexpired, ties by widest (highest mmr_end). 404 when none.
   * Certificates are public material (embedded at label 1000 in every
   * published checkpoint); signers use expiresAt/mmrEnd to anticipate renewal.
   */
  private handleGetDelegation(url: URL): Response {
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

    const nowSeconds = Math.floor(Date.now() / 1000);
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT certificate, issued_at, expires_at, delegated_public_key,
                mmr_start, mmr_end
           FROM delegation_certificates
          WHERE log_id_hex32 = ? AND expires_at > ?
            AND mmr_start IS NOT NULL AND mmr_end IS NOT NULL
          ORDER BY expires_at DESC, mmr_end DESC
          LIMIT 1`,
        logIdHex32,
        nowSeconds,
      ),
    ];
    if (rows.length === 0) {
      return Response.json(
        { type: "about:blank", title: "Not Found", status: 404 },
        { status: 404 },
      );
    }
    const row = rows[0] as {
      certificate: ArrayBuffer;
      issued_at: number;
      expires_at: number;
      delegated_public_key: ArrayBuffer | null;
      mmr_start: number;
      mmr_end: number;
    };
    return Response.json({
      logId: logIdHex32,
      certificate: bytesToBase64(new Uint8Array(row.certificate)),
      mmrStart: row.mmr_start,
      mmrEnd: row.mmr_end,
      delegatedPublicKey: row.delegated_public_key
        ? bytesToBase64(new Uint8Array(row.delegated_public_key))
        : null,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
    });
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
      // The voucher was verified against the pinned registrar key at the worker
      // ingress (handlePostDelegateKeys); it is required and persisted so C3 can
      // advertise it for the kit to re-verify before binding (FOR-390 phase H).
      let voucher: Uint8Array;
      try {
        voucher = base64ToBytes(key.voucher);
      } catch {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "voucher must be valid base64",
          },
          { status: 400 },
        );
      }
      if (voucher.length === 0) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail: "voucher is required",
          },
          { status: 400 },
        );
      }
      const pubkeyHash = await sha256Hex(publicKey);
      this.ctx.storage.sql.exec(
        `INSERT INTO delegate_keys
           (pubkey_hash, sealer_id, alg, public_key, epoch, not_after, voucher)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pubkey_hash) DO UPDATE SET
           sealer_id = excluded.sealer_id,
           alg = excluded.alg,
           public_key = excluded.public_key,
           epoch = excluded.epoch,
           not_after = excluded.not_after,
           voucher = excluded.voucher`,
        pubkeyHash,
        body.sealerId,
        key.alg,
        publicKey,
        key.epoch,
        key.notAfter,
        voucher,
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
    univocity_instance_id: string | null;
    webhook_source: string | null;
    enabled: number;
    user_enabled: number;
    operator_enabled: number;
    created_at: number;
    updated_at: number;
  } | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT webhook_url, univocity_instance_id, webhook_source, enabled,
                user_enabled, operator_enabled, created_at, updated_at
         FROM log_delegation_config WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    if (rows.length === 0) return null;
    return rows[0] as {
      webhook_url: string | null;
      univocity_instance_id: string | null;
      webhook_source: string | null;
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
    univocity_instance_id?: string | null;
    webhook_source?: string | null;
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
    if (row.univocity_instance_id) {
      resp.univocityInstanceId = row.univocity_instance_id;
    }
    if (row.webhook_url && row.webhook_source === WEBHOOK_SOURCE_INSTANCE) {
      resp.inherited = true;
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

  /**
   * PUT /webhook/{logIdHex32} — set an explicit URL and/or bind to an instance.
   *
   * With `univocityInstanceId` and no `url` this is registration-time
   * **inheritance by copy** (ADR-0005 amendment): the instance's webhook —
   * replicated to this shard by the instance fan-out — is written into the
   * log's own row, so the delegation request path never leaves the shard to
   * find it. An instance with no webhook yet still records the binding; the
   * next re-point fills it in.
   */
  private async handlePutWebhookConfig(
    logIdHex32: string,
    request: Request,
  ): Promise<Response> {
    const body = (await request.json()) as PutWebhookRequest;
    const hasUrl = typeof body.url === "string" && body.url.length > 0;
    const hasUnivocityInstanceId =
      typeof body.univocityInstanceId === "string" &&
      body.univocityInstanceId.length > 0;
    if (!hasUrl && !hasUnivocityInstanceId) {
      return Response.json(
        {
          type: "about:blank",
          title: "Invalid request",
          status: 400,
          detail: "url or univocityInstanceId is required",
        },
        { status: 400 },
      );
    }

    let univocityInstanceId: string | null = null;
    if (hasUnivocityInstanceId) {
      try {
        univocityInstanceId = parseUnivocityInstanceId(
          body.univocityInstanceId!,
        );
      } catch (error) {
        return Response.json(
          {
            type: "about:blank",
            title: "Invalid request",
            status: 400,
            detail:
              error instanceof Error
                ? error.message
                : "Invalid univocityInstanceId",
          },
          { status: 400 },
        );
      }
    }

    const now = Date.now();
    const existing = this.readDelegationConfigRow(logIdHex32);
    const userEnabled = existing?.user_enabled ?? 1;
    const operatorEnabled = existing?.operator_enabled ?? 1;
    const createdAt = existing?.created_at ?? now;
    const effectiveUnivocityInstanceId =
      univocityInstanceId ?? existing?.univocity_instance_id ?? null;

    let webhookUrl: string | null;
    let webhookSource: string | null;
    if (hasUrl) {
      webhookUrl = body.url!;
      webhookSource = WEBHOOK_SOURCE_LOG;
    } else {
      // Inherit by copy. Absent instance webhook leaves the URL null, which
      // keeps meaning "pre-emptive supply only" until the instance is pointed.
      webhookUrl =
        this.readInstanceWebhookRow(univocityInstanceId!)?.webhook_url ?? null;
      webhookSource = WEBHOOK_SOURCE_INSTANCE;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO log_delegation_config
         (log_id_hex32, webhook_url, univocity_instance_id, webhook_source,
          enabled, user_enabled, operator_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(log_id_hex32) DO UPDATE SET
         webhook_url = excluded.webhook_url,
         univocity_instance_id = excluded.univocity_instance_id,
         webhook_source = excluded.webhook_source,
         updated_at = excluded.updated_at`,
      logIdHex32,
      webhookUrl,
      effectiveUnivocityInstanceId,
      webhookSource,
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

  /**
   * DELETE /webhook/{logIdHex32} — clear webhook URL.
   *
   * Also clears `webhook_source`, so a later instance re-point does not
   * resurrect a URL the log's owner deliberately removed. The instance binding
   * itself is kept for provenance; re-opt in with `PUT { univocityInstanceId }`.
   */
  private handleDeleteWebhookConfig(logIdHex32: string): Response {
    const now = Date.now();
    const existing = this.readDelegationConfigRow(logIdHex32);
    if (!existing) {
      return Response.json({ ok: true });
    }

    this.ctx.storage.sql.exec(
      `UPDATE log_delegation_config
       SET webhook_url = NULL, webhook_source = NULL, updated_at = ?
       WHERE log_id_hex32 = ?`,
      now,
      logIdHex32,
    );

    return Response.json({ ok: true });
  }

  /** Read this shard's replica of an instance webhook row, or null. */
  private readInstanceWebhookRow(univocityInstanceId: string): {
    webhook_url: string;
    created_at: number;
    updated_at: number;
  } | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT webhook_url, created_at, updated_at
         FROM instance_webhooks WHERE univocity_instance_id = ?`,
        univocityInstanceId,
      ),
    ];
    if (rows.length === 0) return null;
    return rows[0] as {
      webhook_url: string;
      created_at: number;
      updated_at: number;
    };
  }

  /** Count this shard's logs bound to an instance, optionally inherited only. */
  private countInstanceMemberLogs(
    univocityInstanceId: string,
    inheritedOnly: boolean,
  ): number {
    const sql = inheritedOnly
      ? `SELECT COUNT(*) AS n FROM log_delegation_config
         WHERE univocity_instance_id = ? AND webhook_source = '${WEBHOOK_SOURCE_INSTANCE}'`
      : `SELECT COUNT(*) AS n FROM log_delegation_config WHERE univocity_instance_id = ?`;
    const rows = [...this.ctx.storage.sql.exec(sql, univocityInstanceId)];
    return Number((rows[0] as { n: number } | undefined)?.n ?? 0);
  }

  /** GET /instance-webhook/{id} — this shard's view of an instance. */
  private handleGetInstanceWebhook(univocityInstanceId: string): Response {
    const row = this.readInstanceWebhookRow(univocityInstanceId);
    const memberLogs = this.countInstanceMemberLogs(univocityInstanceId, false);
    if (!row && memberLogs === 0) {
      return Response.json(
        { type: "about:blank", title: "Not Found", status: 404 },
        { status: 404 },
      );
    }
    const resp: InstanceWebhookResponse = {
      univocityInstanceId,
      memberLogs,
    };
    if (row) {
      resp.webhookUrl = row.webhook_url;
      resp.createdAt = row.created_at;
      resp.updatedAt = row.updated_at;
    }
    return Response.json(resp);
  }

  /**
   * PUT /instance-webhook/{id} — set or re-point the instance webhook.
   *
   * This is the accepted cost of inherit-by-copy: the worker fans this call out
   * to every shard, and each shard rewrites the copies its own logs hold. Logs
   * carrying an explicit per-log URL (`webhook_source = 'log'`) are left alone,
   * as are logs whose owner cleared the webhook (source NULL).
   */
  private async handlePutInstanceWebhook(
    univocityInstanceId: string,
    request: Request,
  ): Promise<Response> {
    const body = (await request.json()) as PutInstanceWebhookRequest;
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
    const existing = this.readInstanceWebhookRow(univocityInstanceId);
    const createdAt = existing?.created_at ?? now;

    this.ctx.storage.sql.exec(
      `INSERT INTO instance_webhooks
         (univocity_instance_id, webhook_url, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(univocity_instance_id) DO UPDATE SET
         webhook_url = excluded.webhook_url,
         updated_at = excluded.updated_at`,
      univocityInstanceId,
      body.url,
      createdAt,
      now,
    );

    const updatedLogs = this.countInstanceMemberLogs(univocityInstanceId, true);
    this.ctx.storage.sql.exec(
      `UPDATE log_delegation_config
       SET webhook_url = ?, updated_at = ?
       WHERE univocity_instance_id = ? AND webhook_source = ?`,
      body.url,
      now,
      univocityInstanceId,
      WEBHOOK_SOURCE_INSTANCE,
    );

    const resp: InstanceWebhookResponse = {
      univocityInstanceId,
      webhookUrl: body.url,
      createdAt,
      updatedAt: now,
      memberLogs: this.countInstanceMemberLogs(univocityInstanceId, false),
      updatedLogs,
    };
    return Response.json(resp);
  }

  /**
   * DELETE /instance-webhook/{id} — drop the instance webhook.
   *
   * Clears the copies inherited by member logs too; those logs revert to
   * "no webhook", i.e. pre-emptive supply only. Bindings are retained so a
   * later PUT re-points them.
   */
  private handleDeleteInstanceWebhook(univocityInstanceId: string): Response {
    const now = Date.now();
    const updatedLogs = this.countInstanceMemberLogs(univocityInstanceId, true);
    this.ctx.storage.sql.exec(
      `UPDATE log_delegation_config
       SET webhook_url = NULL, updated_at = ?
       WHERE univocity_instance_id = ? AND webhook_source = ?`,
      now,
      univocityInstanceId,
      WEBHOOK_SOURCE_INSTANCE,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM instance_webhooks WHERE univocity_instance_id = ?`,
      univocityInstanceId,
    );
    const resp: InstanceWebhookResponse = {
      univocityInstanceId,
      updatedLogs,
    };
    return Response.json(resp);
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

  /** Signing-route mode for a log, or null when no route is recorded. */
  private signingRouteMode(logIdHex32: string): string | null {
    const rows = [
      ...this.ctx.storage.sql.exec(
        `SELECT mode FROM signing_routes WHERE log_id_hex32 = ?`,
        logIdHex32,
      ),
    ];
    if (rows.length === 0) return null;
    return (rows[0] as { mode: string }).mode;
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
    // Wallet-routed (interactive) logs are served by the pending queue; a
    // webhook copied in via instance binding must not page a signer that
    // cannot sign (Safe 1x1 Mode D — FOR-504).
    if (this.signingRouteMode(input.logIdHex32) === "wallet") {
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
