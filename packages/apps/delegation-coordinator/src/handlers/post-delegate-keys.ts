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
 */

import type { Env } from "../env.js";
import { checkBearerToken } from "../auth/check-bearer-token.js";
import { base64ToBytes } from "../encoding.js";
import type { RegisterDelegateKeysRequest } from "../types/register-delegate-keys-request.js";
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
 * POST /api/sealer/delegate-keys — fan-out delegate-key registration.
 *
 * @param request - JSON {@link RegisterDelegateKeysRequest} body.
 * @param env - Worker bindings.
 * @returns `{ registered, retired, shards }` or a problem Response.
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
    // bad voucher rejects the whole registration (the custodian sends a
    // consistent batch), and nothing unverified is ever written.
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
      const verdict = await verifyDelegateKeyVoucher(voucher, pinnedKey, {
        sealerId: body.sealerId,
        epoch: key.epoch,
        publicKey,
      });
      if (!verdict.ok) {
        return problemResponse(
          400,
          "about:blank",
          "Invalid voucher",
          `delegate-key voucher failed verification (${verdict.reason})`,
        );
      }
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
    for (const res of results) {
      if (!res.ok) {
        // Propagate the shard's problem document verbatim.
        return new Response(res.body, {
          status: res.status,
          headers: res.headers,
        });
      }
      const shardResult = (await res.json()) as {
        registered: number;
        retired: number;
      };
      // Identical keys are written to each shard; report the per-shard count
      // once (max), and the total retired across shards.
      registered = Math.max(registered, shardResult.registered);
      retired += shardResult.retired;
    }

    return Response.json({ registered, retired, shards: shardCount });
  } catch (error) {
    return internalError(error);
  }
}
