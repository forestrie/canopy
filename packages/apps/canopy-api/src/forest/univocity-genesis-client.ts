/**
 * Client for forwarding forest genesis documents to the arbor univocity service
 * (`POST /api/forest/{R}/genesis`). Univocity owns genesis storage and anchors
 * each genesis key to the on-chain `bootstrapConfig()` for its forest's chain /
 * contract. Canopy forwards the canonical v1 genesis CBOR it built (curator
 * token -> univocity token) and keeps a local R2 copy that is authoritative for
 * reads until the subject log's first checkpoint, after which it may be expired.
 *
 * Status mapping (mirrors univocity handlePostGenesis):
 *   - 201 -> created
 *   - 409 -> exists (idempotent; already migrated/provisioned). Since the
 *     arbor claim-first genesis (arbor plan-2607-10, main 7206074) a 409 is
 *     ONLY the same-R exists case — a cross-forest claim conflict answers
 *     422, which lands in `rejected` below. Note exists does NOT imply
 *     byte-equality: univocity's PutGenesisIfAbsent never diffs a repost,
 *     so callers must read back and diff when they hold no local copy.
 *   - 4xx -> rejected (bad genesis / anchor mismatch / claim conflict)
 *   - else -> unavailable (transient/unreachable; treat as 502/503)
 *
 * See plan-0029 (canopy) / plan-0008 (arbor).
 */

import type {
  UnivocityGenesisClient,
  UnivocityGenesisResult,
} from "./univocity-genesis-client-config.js";

export type {
  UnivocityGenesisClient,
  UnivocityGenesisResult,
} from "./types.js";

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function readDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 512);
  } catch {
    return "";
  }
}

/**
 * Every subrequest body must be consumed, even on the statuses whose body
 * is irrelevant — an undrained stream holds the request context (and, in
 * workerd, its storage connections) open.
 */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort — an already-disturbed stream is fine.
  }
}

/**
 * Forwards the canonical genesis CBOR for forest root `R` to univocity.
 *
 * @param client univocity service URL + bearer token.
 * @param rootStorageSeg canonical dashed UUID of forest root `R`.
 * @param genesisCbor canonical v1 genesis document bytes.
 */
export async function postGenesisToUnivocity(
  client: UnivocityGenesisClient,
  rootStorageSeg: string,
  genesisCbor: Uint8Array,
): Promise<UnivocityGenesisResult> {
  let res: Response;
  try {
    res = await fetch(
      joinUrl(client.serviceUrl, `/api/forest/${rootStorageSeg}/genesis`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/cbor",
          Authorization: `Bearer ${client.token}`,
        },
        body: genesisCbor,
      },
    );
  } catch (e) {
    return {
      kind: "unavailable",
      detail:
        e instanceof Error
          ? `univocity genesis unreachable: ${e.message}`
          : "univocity genesis unreachable",
    };
  }

  if (res.status === 201) {
    await drain(res);
    return { kind: "created" };
  }
  if (res.status === 409) {
    await drain(res);
    return { kind: "exists" };
  }
  if (res.status >= 400 && res.status < 500) {
    return {
      kind: "rejected",
      status: res.status,
      detail: await readDetail(res),
    };
  }
  return {
    kind: "unavailable",
    detail: `univocity genesis returned ${res.status}: ${await readDetail(res)}`,
  };
}

export type UnivocityGenesisReadBack =
  | { kind: "ok"; body: Uint8Array }
  | { kind: "missing" }
  | { kind: "unavailable"; detail: string };

/**
 * Read back the genesis univocity holds for forest root `R`
 * (`GET /api/forest/{R}/genesis`, unauthenticated, raw CBOR). Used by the
 * forward path when univocity answers exists but the local authoritative
 * copy is absent (a created-then-local-put-fail crash window): exists does
 * not imply byte-equality, so the retry body must be diffed against the
 * stored document before it may become the local copy.
 */
export async function getGenesisFromUnivocity(
  client: UnivocityGenesisClient,
  rootStorageSeg: string,
): Promise<UnivocityGenesisReadBack> {
  let res: Response;
  try {
    res = await fetch(
      joinUrl(client.serviceUrl, `/api/forest/${rootStorageSeg}/genesis`),
    );
  } catch (e) {
    return {
      kind: "unavailable",
      detail:
        e instanceof Error
          ? `univocity genesis read-back unreachable: ${e.message}`
          : "univocity genesis read-back unreachable",
    };
  }
  if (res.status === 200) {
    return { kind: "ok", body: new Uint8Array(await res.arrayBuffer()) };
  }
  if (res.status === 404) {
    await drain(res);
    return { kind: "missing" };
  }
  return {
    kind: "unavailable",
    detail: `univocity genesis read-back returned ${res.status}: ${await readDetail(res)}`,
  };
}
