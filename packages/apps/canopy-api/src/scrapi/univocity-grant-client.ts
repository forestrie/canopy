/**
 * Client for delegating creation-grant validation to the arbor univocity
 * service (`POST /api/grants`). Univocity owns the off-chain grant store and is
 * the authority that verifies the grant signature chain (envelope vs the
 * owner's root key, anchored to the on-chain bootstrap key) and enforces global
 * `logId -> R` uniqueness via an atomic index create.
 *
 * Canopy posts the raw transparent statement bytes (the `Forestrie-Grant`
 * credential) plus the forest root `R` (the register path's bootstrap-logid).
 * The HTTP status maps to the register-grant edge decision:
 *
 *   - 201 -> accepted (new logId index entry created)
 *   - 200 -> accepted (idempotent re-post; same logId -> R)
 *   - 409 -> conflict (logId already bound to a different forest)
 *   - 4xx -> rejected (invalid/unauthorized grant chain)
 *   - else -> unavailable (treat as 503; univocity transient/unreachable)
 *
 * See plan-0008 (arbor) / plan-0029 (canopy): univocity-owned grant store and
 * authority resolver.
 */

import { encode as encodeCbor } from "cbor-x";

/** Configuration for reaching the univocity grants endpoint. */
export interface UnivocityGrantClient {
  /** Base service URL, e.g. `https://univocity.example`. */
  serviceUrl: string;
  /** Bearer token authorizing canopy -> univocity calls. */
  token: string;
}

export type UnivocityGrantResult =
  | { kind: "accepted"; created: boolean }
  | { kind: "conflict"; detail: string }
  | { kind: "rejected"; status: number; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * Seam for creation-grant validation. register-grant depends only on this
 * interface, so unit tests can inject a mock and exercise the whole flow without
 * HTTP or local crypto. The production implementation forwards to univocity.
 */
export interface CreationGrantValidator {
  /**
   * @param rootLogId 16-byte forest root `R` (bootstrap log id).
   * @param statementBytes raw transparent statement (COSE Sign1) credential.
   */
  validate(
    rootLogId: Uint8Array,
    statementBytes: Uint8Array,
  ): Promise<UnivocityGrantResult>;
}

/** Builds the univocity-backed {@link CreationGrantValidator}. */
export function createUnivocityGrantValidator(
  client: UnivocityGrantClient,
): CreationGrantValidator {
  return {
    validate: (rootLogId, statementBytes) =>
      postCreationGrantToUnivocity(client, rootLogId, statementBytes),
  };
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function readProblemDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 512);
  } catch {
    return "";
  }
}

/**
 * Posts a creation grant to univocity for authoritative validation + storage.
 *
 * @param client univocity service URL + bearer token.
 * @param rootLogId 16-byte forest root `R` (bootstrap log id).
 * @param statementBytes raw transparent statement (COSE Sign1) credential.
 */
export async function postCreationGrantToUnivocity(
  client: UnivocityGrantClient,
  rootLogId: Uint8Array,
  statementBytes: Uint8Array,
): Promise<UnivocityGrantResult> {
  const body = encodeCbor({
    rootLogId,
    statement: statementBytes,
  }) as Uint8Array;

  let res: Response;
  try {
    res = await fetch(joinUrl(client.serviceUrl, "/api/grants"), {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        Authorization: `Bearer ${client.token}`,
      },
      body,
    });
  } catch (e) {
    return {
      kind: "unavailable",
      detail:
        e instanceof Error
          ? `univocity grants unreachable: ${e.message}`
          : "univocity grants unreachable",
    };
  }

  if (res.status === 201) return { kind: "accepted", created: true };
  if (res.status === 200) return { kind: "accepted", created: false };
  if (res.status === 409) {
    return { kind: "conflict", detail: await readProblemDetail(res) };
  }
  if (res.status >= 400 && res.status < 500) {
    return {
      kind: "rejected",
      status: res.status,
      detail: await readProblemDetail(res),
    };
  }
  return {
    kind: "unavailable",
    detail: `univocity grants returned ${res.status}: ${await readProblemDetail(res)}`,
  };
}
