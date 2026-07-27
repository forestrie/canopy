/**
 * One account per univocity instance (ADR-0059 decisions 1 and 8,
 * plan-2607-43 D7, plan-2607-02 R1).
 *
 * The uniqueness claim at `forests/index/chain-binding/{univocityInstanceId}`
 * is a two-state reservation record. It is created `reserved` at the
 * admission moment — paid or approved redeem, or ops break-glass mint — and
 * completed `registered` by genesis. Payment is captured only after the
 * reservation is held, and genesis never *takes* a claim it could lose, so a
 * conflict can never consume a paid credential.
 *
 * Creation relies on R2's conditional put (`etagDoesNotMatch: "*"`) being an
 * atomic create-if-absent; completion relies on `etagMatches` CAS. Both are
 * load-bearing for one-account-per-instance under concurrency.
 *
 * The record is also the accrual indexer's account-enumeration surface
 * (plan-2607-43 slice 03) and the object the ops release route acts on.
 */

import type { UnivocityInstanceId } from "@canopy/univocity-instance-id";

export interface InstanceRegistryEnv {
  R2_GRANTS: R2Bucket;
}

/**
 * Who holds a reservation: the onboard request that paid or was approved
 * (`request:{requestId}`), the break-glass token (`token:{hash}`), or
 * `genesis` for records claimed directly at genesis (legacy bindingless
 * tokens, endorsement-mode genesis).
 */
export type ReservationHolder = string;

export interface InstanceReservation {
  state: "reserved" | "registered";
  holder: ReservationHolder;
  reservedAt: number;
  /** Forest root UUID; present once `registered`. */
  r?: string;
  /**
   * Chain head observed when the reservation completed to `registered` —
   * the account's metering floor: the accrual indexer's first-sight scan
   * starts here, inclusive (plan-2607-04 / FOR-477). Best-effort: `null`
   * when the genesis-time RPC observation failed, repairable via the ops
   * chain-bindings PATCH. The operator bills from registration, never from
   * contract deployment — pre-registration self-anchored checkpoints are
   * deliberately outside the floor.
   */
  registrationBlock?: number | null;
}

/** A usable metering floor: a non-negative safe integer block height. */
export function isValidRegistrationBlock(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export type ReserveResult =
  | { ok: true; record: InstanceReservation }
  | { ok: false; reason: "conflict" };

export type CompleteResult =
  | { ok: true; record: InstanceReservation }
  | { ok: false; reason: "conflict"; claimedBy?: string }
  | { ok: false; reason: "cas_failed" };

export function requestHolder(requestId: string): ReservationHolder {
  return `request:${requestId}`;
}

export function tokenHolder(tokenHash: string): ReservationHolder {
  return `token:${tokenHash}`;
}

function instanceIndexR2Key(id: UnivocityInstanceId): string {
  return `forests/index/chain-binding/${id}`;
}

function decodeReservation(text: string): InstanceReservation | null {
  try {
    const parsed = JSON.parse(text) as InstanceReservation;
    if (
      (parsed.state !== "reserved" && parsed.state !== "registered") ||
      typeof parsed.holder !== "string" ||
      typeof parsed.reservedAt !== "number"
    ) {
      return null;
    }
    // Tolerant read: a malformed registrationBlock degrades to "absent"
    // rather than invalidating the record.
    if (
      parsed.registrationBlock !== undefined &&
      parsed.registrationBlock !== null &&
      !isValidRegistrationBlock(parsed.registrationBlock)
    ) {
      delete parsed.registrationBlock;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function readRaw(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
): Promise<{ record: InstanceReservation; etag: string } | null> {
  const got = await env.R2_GRANTS.get(instanceIndexR2Key(id));
  if (!got) return null;
  const record = decodeReservation(await got.text());
  if (!record) return null;
  return { record, etag: got.etag };
}

async function putReservation(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
  record: InstanceReservation,
  onlyIf: R2PutOptions["onlyIf"],
): Promise<boolean> {
  const written = await env.R2_GRANTS.put(
    instanceIndexR2Key(id),
    JSON.stringify(record),
    { httpMetadata: { contentType: "application/json" }, onlyIf },
  );
  return written !== null;
}

/**
 * Reserve `id` for `holder` at the admission moment. Idempotent for the same
 * holder (a redeem retry, or a genesis-completed record still held by the
 * same flow). Any other holder is a conflict — callers return a 409 that
 * deliberately does NOT name the holder (a foreign requestId is not the
 * caller's to learn); the ops inspection route carries the detail.
 */
export async function reserveUnivocityInstance(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
  holder: ReservationHolder,
): Promise<ReserveResult> {
  const record: InstanceReservation = {
    state: "reserved",
    holder,
    reservedAt: Math.floor(Date.now() / 1000),
  };
  if (await putReservation(env, id, record, { etagDoesNotMatch: "*" })) {
    return { ok: true, record };
  }
  const existing = await readRaw(env, id);
  if (existing && existing.record.holder === holder) {
    return { ok: true, record: existing.record };
  }
  return { ok: false, reason: "conflict" };
}

/**
 * Complete a reservation at genesis: `reserved` (held by one of
 * `acceptHolders`) → `registered{r}`. Also accepts an already-`registered`
 * record for the same `r` (idempotent genesis retry).
 *
 * When no record exists — legacy bindingless-token and endorsement-mode
 * genesis, which never passed through a reserving admission — the record is
 * created directly as `registered` with holder `genesis`,
 * claim-before-consume order preserved by the caller.
 *
 * `registrationBlock` is the caller's best-effort chain-head observation for
 * this registration (`null` when unavailable); recorded on whichever path
 * performs the write. An idempotent retry against an already-`registered`
 * record keeps the original observation.
 */
export async function completeUnivocityInstanceReservation(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
  acceptHolders: ReservationHolder[],
  rUuid: string,
  registrationBlock: number | null,
): Promise<CompleteResult> {
  const existing = await readRaw(env, id);

  if (!existing) {
    const record: InstanceReservation = {
      state: "registered",
      holder: "genesis",
      reservedAt: Math.floor(Date.now() / 1000),
      r: rUuid,
      registrationBlock,
    };
    if (await putReservation(env, id, record, { etagDoesNotMatch: "*" })) {
      return { ok: true, record };
    }
    // Lost a create race; re-read and fall through to the held-record logic.
    return completeUnivocityInstanceReservation(
      env,
      id,
      acceptHolders,
      rUuid,
      registrationBlock,
    );
  }

  const { record, etag } = existing;
  if (record.state === "registered") {
    if (record.r === rUuid) return { ok: true, record };
    return { ok: false, reason: "conflict", claimedBy: record.r };
  }

  if (!acceptHolders.includes(record.holder)) {
    return { ok: false, reason: "conflict" };
  }

  // A failed observation must not clobber a floor already repaired onto the
  // held reservation (plan-2607-05 R2); a successful one wins — it is the
  // measurement at the true registration moment.
  const updated: InstanceReservation = {
    ...record,
    state: "registered",
    r: rUuid,
    registrationBlock: registrationBlock ?? record.registrationBlock ?? null,
  };
  if (await putReservation(env, id, updated, { etagMatches: etag })) {
    return { ok: true, record: updated };
  }
  // CAS lost: a concurrent completion won (possibly ours, retried).
  const reread = await readRaw(env, id);
  if (reread?.record.state === "registered" && reread.record.r === rUuid) {
    return { ok: true, record: reread.record };
  }
  return { ok: false, reason: "cas_failed" };
}

/** Read the reservation record for `id`, if any (ops inspection, R4). */
export async function readUnivocityInstanceReservation(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
): Promise<InstanceReservation | null> {
  const raw = await readRaw(env, id);
  return raw?.record ?? null;
}

export type SetRegistrationBlockResult =
  | { ok: true; record: InstanceReservation }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "cas_failed" };

/**
 * Ops repair of the metering floor (plan-2607-04): the ONLY mutation path
 * for `registrationBlock` besides genesis itself. Deliberately not exposed
 * to account owners — the floor is the operator's meter; an owner-set
 * inflated floor before first sight is a billing bypass.
 */
export async function setUnivocityInstanceRegistrationBlock(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
  registrationBlock: number,
): Promise<SetRegistrationBlockResult> {
  const existing = await readRaw(env, id);
  if (!existing) return { ok: false, reason: "not_found" };
  const updated: InstanceReservation = {
    ...existing.record,
    registrationBlock,
  };
  if (await putReservation(env, id, updated, { etagMatches: existing.etag })) {
    return { ok: true, record: updated };
  }
  return { ok: false, reason: "cas_failed" };
}

/**
 * Release a reservation (ops, R4): dangling `reserved` records, squats made
 * before the registrant attestation is enforced, abandoned roots. Returns
 * what was released, or null when nothing was held.
 */
export async function releaseUnivocityInstanceReservation(
  env: InstanceRegistryEnv,
  id: UnivocityInstanceId,
): Promise<InstanceReservation | null> {
  const raw = await readRaw(env, id);
  if (!raw) return null;
  await env.R2_GRANTS.delete(instanceIndexR2Key(id));
  return raw.record;
}
