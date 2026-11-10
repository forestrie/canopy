/**
 * Admission under a log's authority: canopy-api admits nothing under a log
 * whose key the chain has not fixed. The protocol's rule is in
 * [log-authority-and-grants.md §5.1](https://github.com/forestrie/protocol/blob/main/spec/log-authority-and-grants.md)
 * and [protocol ADR-0070](https://github.com/forestrie/protocol/blob/main/adr/adr-0070-sec-log-authority-anchored-before-use.md);
 * canopy's part is [devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decisions 5 and 8.
 *
 * Statement registration checks the log it appends to; grant registration
 * checks the owner log the grant is sequenced into. Both refuse before any
 * other work that costs the caller, in particular before an x402 payment is
 * verified or settled, so a retry after anchoring is charged once.
 */

import { cborResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import { isCanopyApiPoolTestMode } from "../env/runtime-mode.js";
import type { LogAuthorityReader } from "../env/log-authority-reader.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";

/** Problem type for a log that is claimed but not yet anchored. */
export const PROBLEM_AUTHORITY_PENDING = "authority-pending";
/** Problem type for a conflicted log, or one under a conflicted ancestor. */
export const PROBLEM_AUTHORITY_CONFLICT = "authority-conflict";

/**
 * Seconds a client should wait before retrying a pending log. Anchoring
 * waits for the owner's next published checkpoint, which is minutes away at
 * most, so this paces polling rather than predicting it.
 */
export const AUTHORITY_PENDING_RETRY_AFTER_SECONDS = 30;

/** Seconds to wait before retrying when univocity cannot answer. */
const AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/**
 * Refuses unless `logId`'s authority is anchored, with every ancestor
 * anchored too.
 *
 * - pending: 409 `authority-pending` with `Retry-After`; the body carries the
 *   log's `state`, the first ancestor not anchored (`blockedBy`) and a
 *   reservation's `expiresAt`, so the caller can see what it waits for;
 * - conflicted, or under a conflicted ancestor: 409 `authority-conflict`, no
 *   `Retry-After`: the log never takes writes again;
 * - no claim in univocity: 403;
 * - univocity unavailable with nothing cached, or no reader configured: 503.
 *   There is no fallback source of authority.
 *
 * @param reader the log authority reader; absent when univocity is not
 *   configured. Only pool-test mode (`NODE_ENV` test) admits without one.
 * @returns the refusal, or null to admit.
 */
export async function refuseUnlessAnchored(
  logId: Uint8Array,
  reader: LogAuthorityReader | undefined,
  nodeEnv: string | undefined,
): Promise<Response | null> {
  if (!reader) {
    if (isCanopyApiPoolTestMode({ NODE_ENV: nodeEnv ?? "production" })) {
      return null;
    }
    return ServerErrors.serviceUnavailable(
      "Log authority is not configured (UNIVOCITY_SERVICE_URL required).",
    );
  }

  const logUuid = bytesToUuid(logId);
  const authority = await reader.read(logId);
  switch (authority.kind) {
    case "anchored":
      return null;
    case "pending":
      return cborResponse(
        {
          type: PROBLEM_AUTHORITY_PENDING,
          title: "Authority Pending",
          status: 409,
          detail: `Log ${logUuid} is not anchored on chain yet; retry after its owner's next published checkpoint.`,
          logId: logUuid,
          state: authority.state,
          ...(authority.blockedBy
            ? { blockedBy: bytesToUuid(authority.blockedBy) }
            : {}),
          ...(authority.expiresAt !== undefined
            ? { expiresAt: authority.expiresAt }
            : {}),
        },
        409,
        { "Retry-After": String(AUTHORITY_PENDING_RETRY_AFTER_SECONDS) },
      );
    case "conflicted":
      return cborResponse(
        {
          type: PROBLEM_AUTHORITY_CONFLICT,
          title: "Authority Conflict",
          status: 409,
          detail: authority.blockedBy
            ? `Log ${logUuid} is under conflicted log ${bytesToUuid(authority.blockedBy)}: the chain recorded a different owner or key than its claim. Start a new log.`
            : `Log ${logUuid} is conflicted: the chain recorded a different owner or key than its claim. Start a new log.`,
          logId: logUuid,
          state: "conflicted",
          ...(authority.blockedBy
            ? { blockedBy: bytesToUuid(authority.blockedBy) }
            : {}),
        },
        409,
      );
    case "unclaimed":
      return ClientErrors.forbidden(
        `Log ${logUuid} has no claim: it must be created through its owner's create grant first.`,
      );
    case "unavailable":
      return ServerErrors.serviceUnavailableWithRetry(
        `Log authority is unavailable: ${authority.detail}`,
        AUTHORITY_UNAVAILABLE_RETRY_AFTER_SECONDS,
      );
  }
}
