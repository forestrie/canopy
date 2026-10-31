/**
 * POST /api/sealer/delegate-keys — register a sealer's standing delegate keys.
 *
 * Delegate keys are per-sealer, but the store is sharded per-log and coverage
 * retrieval LEFT JOINs delegate_keys against a log's certificates within a
 * single shard. So registration must reach EVERY shard — this handler fans the
 * idempotent upsert out to all of them.
 *
 * The registrar is the custodian (FOR-390 phase H): each key carries a
 * custodian-signed voucher, verified here against PINNED_REGISTRAR_KEY before
 * fan-out. The app-token gates access; the voucher is the real gate on
 * legitimacy — a compromised COORDINATOR_APP_TOKEN cannot introduce a key the
 * custodian did not vouch for, so it can never be advertised or delegated to.
 *
 * Vouchers expire (plan-2609-12 ruling 7, slice 08): a voucher must carry
 * claim 4 (notAfter), not yet passed and at most
 * {@link MAX_VOUCHER_LIFETIME_SECONDS} out, and the row's notAfter is capped
 * at it. The arbor sealer asserts each key every minute with the voucher the
 * custodian issued it, so a refused voucher answers 400 "Invalid voucher",
 * on which the sealer fetches fresh ones; an assertion identical to the
 * stored row writes nothing.
 *
 * Each shard refuses a tombstoned key with 410 (ruling 8), then enforces one
 * key per (sealerId, epoch) among unexpired rows and answers 409 with both
 * hashes for a conflicting registration (ruling 4); both are propagated
 * verbatim. Sibling routes: lookup by hash
 * ({@link handleGetDelegateKey}), by-sealer listing
 * ({@link handleListDelegateKeys}), the operator-plane delete
 * ({@link handleAdminDeleteDelegateKeys}) that precedes a MAC-key replacement,
 * and the tombstones ({@link handleAdminPostDelegateKeyTombstone}).
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { base64ToBytes } from "../encoding.js";
import type { RegisterDelegateKeysRequest } from "../types/register-delegate-keys-request.js";
// Doc links only; the sibling handlers are routed from index.ts.
import type { handleGetDelegateKey } from "./get-delegate-key.js";
import type { handleListDelegateKeys } from "./list-delegate-keys.js";
import type { handleAdminDeleteDelegateKeys } from "./admin-delete-delegate-keys.js";
import type { handleAdminPostDelegateKeyTombstone } from "./admin-delegate-key-tombstones.js";
import {
  parseRegistrarKeyXY,
  verifyDelegateKeyVoucher,
} from "@forestrie/encoding";
import {
  getShardCount,
  getStoreStub,
  internalError,
  problemResponse,
} from "./handler.js";

/**
 * Furthest a voucher's claim 4 may lie in the future. The custodian's
 * `DELEGATE_KEY_VOUCHER_TTL` is bounded to 30 days; one more day absorbs
 * clock skew. A voucher further out is refused rather than capped, because
 * no custodian issues one.
 */
export const MAX_VOUCHER_LIFETIME_SECONDS = 31 * 24 * 3600;

/** Per-shard answer of PUT /sealer/delegate-keys. */
interface ShardRegistration {
  registered: number;
  retired: number;
  /** Hashes whose row this shard inserted or changed. */
  written: string[];
}

/**
 * POST /api/sealer/delegate-keys — fan-out delegate-key registration.
 *
 * @param request - JSON {@link RegisterDelegateKeysRequest} body.
 * @param env - Worker bindings.
 * @returns `{ registered, retired, written, shards }` or a problem Response;
 *   `written` counts keys whose row changed, so 0 for a repeated assertion.
 */
export async function handlePostDelegateKeys(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const authErr = checkBearerToken(request, env.COORDINATOR_APP_TOKEN);
    if (authErr) return authErr;

    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) {
      return problemResponse(
        415,
        "about:blank",
        "Unsupported Media Type",
        "Content-Type must be application/json",
      );
    }

    const body = (await request.json()) as RegisterDelegateKeysRequest;
    if (!body.sealerId || !Array.isArray(body.keys) || body.keys.length === 0) {
      return problemResponse(
        400,
        "about:blank",
        "Invalid request",
        "sealerId and a non-empty keys[] are required",
      );
    }

    // Fail closed: without a pinned registrar key no voucher can be verified,
    // so no delegate key may be registered.
    if (!env.PINNED_REGISTRAR_KEY?.trim()) {
      return problemResponse(
        503,
        "about:blank",
        "Service Unavailable",
        "PINNED_REGISTRAR_KEY is not configured",
      );
    }
    let pinnedKey: ReturnType<typeof parseRegistrarKeyXY>;
    try {
      pinnedKey = parseRegistrarKeyXY(
        base64ToBytes(env.PINNED_REGISTRAR_KEY.trim()),
      );
    } catch {
      pinnedKey = null;
    }
    if (!pinnedKey) {
      return problemResponse(
        500,
        "about:blank",
        "Misconfigured",
        "PINNED_REGISTRAR_KEY must be base64 x||y (64 bytes)",
      );
    }

    // Verify every key's custodian voucher before touching any shard: a single
    // bad voucher rejects the whole registration, and nothing unverified is
    // ever written.
    const now = Math.floor(Date.now() / 1000);
    for (const key of body.keys) {
      let publicKey: Uint8Array;
      let voucher: Uint8Array;
      try {
        publicKey = base64ToBytes(key.publicKey);
        voucher = base64ToBytes(key.voucher);
      } catch {
        return problemResponse(
          400,
          "about:blank",
          "Invalid request",
          "publicKey and voucher must be valid base64",
        );
      }
      const verdict = await verifyDelegateKeyVoucher(
        voucher,
        pinnedKey,
        { sealerId: body.sealerId, epoch: key.epoch, publicKey },
        now,
        { requireNotAfter: true },
      );
      if (!verdict.ok) return invalidVoucher(verdict.reason);
      // requireNotAfter: a verified voucher always carries claim 4.
      const claimNotAfter = verdict.notAfter!;
      if (claimNotAfter > now + MAX_VOUCHER_LIFETIME_SECONDS) {
        return invalidVoucher("not_after_too_far");
      }
      // The signed claim bounds the row; the body field may only shorten it.
      key.notAfter = Math.min(key.notAfter, claimNotAfter);
    }

    const payload = JSON.stringify(body);
    const shardCount = getShardCount(env);

    // Fan out to every shard. A single shard rejecting (e.g. a malformed key)
    // is a client error that applies to all, so surface the first non-2xx.
    const results = await Promise.all(
      Array.from({ length: shardCount }, (_, i) =>
        getStoreStub(env, i).fetch("https://do.internal/sealer/delegate-keys", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }),
      ),
    );

    let registered = 0;
    let retired = 0;
    const written = new Set<string>();
    for (const res of results) {
      if (!res.ok) {
        // Propagate the shard's problem document verbatim.
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      const shardResult = (await res.json()) as ShardRegistration;
      // Identical keys are written to each shard; report the per-shard count
      // once (max), and the total retired across shards.
      registered = Math.max(registered, shardResult.registered);
      retired += shardResult.retired;
      for (const hash of shardResult.written) written.add(hash);
    }

    // Ruling 4': the coordinator logs each registration whose row changed.
    // A repeated assertion changes nothing and logs nothing.
    if (written.size > 0) {
      console.info(
        JSON.stringify({
          event: "delegate_keys_registered",
          sealerId: body.sealerId,
          pubkeyHashes: [...written].sort(),
          keys: body.keys.map((k) => ({
            epoch: k.epoch,
            notAfter: k.notAfter,
          })),
          shards: shardCount,
        }),
      );
    }

    return Response.json({
      registered,
      retired,
      written: written.size,
      shards: shardCount,
    });
  } catch (error) {
    return internalError(error);
  }
}

/**
 * The 400 for a refused voucher. The title is a wire contract: on it the arbor
 * sealer fetches fresh vouchers before asserting again (arbor
 * `services/sealer/src/delegate_key_registrar.go`, `voucherFixes`).
 *
 * @param reason - The failing check, e.g. `not_after_missing`, `expired`,
 *   `not_after_too_far` or a {@link verifyDelegateKeyVoucher} reason.
 */
function invalidVoucher(reason: string): Response {
  return problemResponse(
    400,
    "about:blank",
    "Invalid voucher",
    `delegate-key voucher failed verification (${reason})`,
  );
}
