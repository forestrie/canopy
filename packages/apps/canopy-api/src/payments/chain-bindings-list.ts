/**
 * `GET /api/payments/chain-bindings` — ops enumeration of registered
 * univocity instances with registry + receivables status in one response
 * (FOR-478).
 *
 * The data is split across owners: canopy-api holds the R2 reservation
 * registry; x402-settlement holds watermarks/balances behind
 * `/admin/receivables/{id}`. This route does the join the per-id routes
 * can't: each `registered` row carries its receivables posture (credits
 * balance, accrued count, arrears, `enforcementFrozen`, watermark), fetched
 * via the same fronted ops identity as the FOR-497 owner read. `reserved`
 * rows are listed without a join — they name no root and have no account
 * state to bill.
 *
 * Failure posture is per-row: a settlement outage (or an account the indexer
 * has not yet seen) degrades that row to `receivables: null` with a
 * `receivablesDetail`, never the whole listing — enumeration is the ops
 * inspection surface and must not depend on the thing it inspects.
 */

import { cborResponse, problemResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import {
  InvalidReservationCursorError,
  listUnivocityInstanceReservations,
  type InstanceRegistryEnv,
  type InstanceReservationListItem,
} from "./instance-registry.js";
import { getSettlementReceivables } from "./settlement-receivables-client.js";
import type {
  SettlementReceivablesClientEnv,
  SettlementReceivablesRead,
} from "./settlement-receivables-result.js";

export type ChainBindingsListEnv = InstanceRegistryEnv &
  SettlementReceivablesClientEnv;

/**
 * Page-size default and cap. Every listed key costs one R2 get and every
 * `registered` row one settlement subrequest, so the cap is a per-request
 * subrequest budget, not a taste choice.
 */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface InstanceStatusRow extends InstanceReservationListItem {
  /** Present on `registered` rows: the posture, or `null` when unreadable. */
  receivables?: SettlementReceivablesRead | null;
  /** Why `receivables` is `null` (upstream detail; ops-facing). */
  receivablesDetail?: string;
}

export async function handleChainBindingsList(
  request: Request,
  env: ChainBindingsListEnv,
): Promise<Response> {
  if (request.method !== "GET") {
    return problemResponse(405, "Method Not Allowed", "about:blank", {
      detail: `Method ${request.method} not allowed`,
    });
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get("limit"));
  if (limit === null) {
    return ClientErrors.badRequest(
      `limit must be an integer in 1..${MAX_LIMIT}`,
    );
  }
  const cursor = url.searchParams.get("cursor") ?? undefined;

  let page;
  try {
    page = await listUnivocityInstanceReservations(env, { cursor, limit });
  } catch (err) {
    // Only a rejected caller-supplied cursor is a client error; hydration
    // and cursorless list failures propagate to the platform 500
    // (plan-2607-08 R1 — a 400 during an R2 incident misleads ops).
    if (err instanceof InvalidReservationCursorError) {
      return ClientErrors.badRequest("invalid cursor");
    }
    throw err;
  }

  const instances = await Promise.all(
    page.items.map((item) => joinReceivables(env, item)),
  );
  return cborResponse(
    {
      instances,
      ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
    },
    200,
  );
}

async function joinReceivables(
  env: ChainBindingsListEnv,
  item: InstanceReservationListItem,
): Promise<InstanceStatusRow> {
  if (item.state !== "registered") return item;
  const result = await getSettlementReceivables(env, item.univocityInstanceId);
  if (result.ok) return { ...item, receivables: result.read };
  return { ...item, receivables: null, receivablesDetail: result.detail };
}

function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}
