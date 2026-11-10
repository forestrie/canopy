/**
 * Client for claiming a create grant through the arbor univocity service
 * (`POST /api/grants`). Univocity owns the off-chain grant store: it verifies
 * the grant's envelope against the owner's root key (anchored to the on-chain
 * bootstrap key), enforces global `logId -> R` uniqueness, and stores the
 * grant write-once ([devdocs ADR-0075](https://github.com/forestrie/devdocs/blob/main/adr/adr-0075-sec-child-root-claimed-once.md)
 * decisions 1 and 2).
 *
 * A claim carries an intent. `prepare` reserves (`reserve`): the claim lapses
 * at `expiresAt` unless committed, and a re-post refreshes it. Create commits
 * (`commit`): the grant will be sequenced, so its claim never lapses. The HTTP
 * status maps to {@link UnivocityGrantResult}: 201/200 accepted (200 for the
 * same grant again), 409 conflict, other 4xx rejected, anything else
 * unavailable.
 */

import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import type {
  CreationGrantValidator,
  UnivocityGrantClient,
  UnivocityGrantResult,
} from "./univocity-grant-client-config.js";

export type {
  CreationGrantValidator,
  UnivocityGrantClient,
  UnivocityGrantResult,
} from "./types.js";

/** A claim's intent (`postGrantRequest.intent` in univocity). */
export type GrantClaimIntent = "reserve" | "commit";

/** Builds the univocity-backed {@link CreationGrantValidator}: commits. */
export function createUnivocityGrantValidator(
  client: UnivocityGrantClient,
): CreationGrantValidator {
  return {
    validate: (rootLogId, statementBytes) =>
      postGrantClaimToUnivocity(client, statementBytes, "commit", rootLogId),
  };
}

/**
 * Reserves a child's create grant for `prepare`. No forest root is sent:
 * univocity finds it from the owner's claim. An accepted reservation always
 * carries `expiresAt`, unless the same grant was already committed.
 */
export async function reserveChildGrantWithUnivocity(
  client: UnivocityGrantClient,
  statementBytes: Uint8Array,
): Promise<UnivocityGrantResult> {
  const result = await postGrantClaimToUnivocity(
    client,
    statementBytes,
    "reserve",
  );
  if (
    result.kind === "accepted" &&
    result.state === "reserved" &&
    result.expiresAt === undefined
  ) {
    // Forwarding a root without its lapse time would outlive the claim.
    return {
      kind: "unavailable",
      detail: "univocity reserved the grant without a lapse time",
    };
  }
  return result;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function readProblem(
  res: Response,
): Promise<{ title: string; detail: string }> {
  let text = "";
  try {
    text = (await res.text()).slice(0, 2048);
  } catch {
    return { title: "", detail: "" };
  }
  try {
    const p = JSON.parse(text) as { title?: unknown; detail?: unknown };
    const title = typeof p.title === "string" ? p.title : "";
    const detail = typeof p.detail === "string" ? p.detail : "";
    return { title, detail: detail || title };
  } catch {
    return { title: "", detail: text.slice(0, 512) };
  }
}

/** Reads univocity's CBOR claim answer `{state, expiresAt?}`, or null. */
async function readClaimAnswer(
  res: Response,
): Promise<{ state: string; expiresAt?: number } | null> {
  let fields: Record<string, unknown>;
  try {
    const decoded = decodeCborDeterministic(
      new Uint8Array(await res.arrayBuffer()),
    );
    if (decoded instanceof Map) {
      fields = Object.fromEntries(
        [...decoded.entries()].map(([k, v]) => [String(k), v]),
      );
    } else if (typeof decoded === "object" && decoded !== null) {
      fields = decoded as Record<string, unknown>;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (typeof fields.state !== "string" || !fields.state) return null;
  const raw = fields.expiresAt;
  const expiresAt =
    typeof raw === "number" && Number.isInteger(raw)
      ? raw
      : typeof raw === "bigint" && Number.isSafeInteger(Number(raw))
        ? Number(raw)
        : undefined;
  return expiresAt === undefined
    ? { state: fields.state }
    : { state: fields.state, expiresAt };
}

/**
 * Posts a create grant claim to univocity.
 *
 * @param client univocity service URL + bearer token.
 * @param statementBytes raw transparent statement (COSE Sign1) credential.
 * @param intent `reserve` (prepare) or `commit` (create, before sequencing).
 * @param rootLogId 16-byte forest root `R`, when the caller knows it.
 */
export async function postGrantClaimToUnivocity(
  client: UnivocityGrantClient,
  statementBytes: Uint8Array,
  intent: GrantClaimIntent,
  rootLogId?: Uint8Array,
): Promise<UnivocityGrantResult> {
  const body = encodeCborDeterministic({
    ...(rootLogId ? { rootLogId } : {}),
    statement: statementBytes,
    intent,
  });

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

  if (res.status === 201 || res.status === 200) {
    const answer = await readClaimAnswer(res);
    if (!answer) {
      return {
        kind: "unavailable",
        detail: `univocity grants returned ${res.status} with an unreadable answer`,
      };
    }
    return { kind: "accepted", created: res.status === 201, ...answer };
  }
  if (res.status === 409) {
    return { kind: "conflict", ...(await readProblem(res)) };
  }
  if (res.status >= 400 && res.status < 500) {
    return {
      kind: "rejected",
      status: res.status,
      detail: (await readProblem(res)).detail,
    };
  }
  return {
    kind: "unavailable",
    detail: `univocity grants returned ${res.status}: ${(await readProblem(res)).detail}`,
  };
}
