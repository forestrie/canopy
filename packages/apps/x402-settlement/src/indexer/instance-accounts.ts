/**
 * Enumerate registered instance accounts from the reservation registry.
 *
 * Writer of record: canopy-api `src/payments/instance-registry.ts` (ADR-0059
 * decision 8) — `forests/index/chain-binding/{univocityInstanceId}` holding
 * `{ state: "reserved"|"registered", holder, reservedAt, r? }`. This reader
 * is deliberately tolerant and read-only. `reserved` records are skipped:
 * they name no root and have no contract activity to bill — they surface via
 * the ops chain-bindings route instead.
 */

import { chainBindingFromUnivocityInstanceId } from "@canopy/univocity-instance-id";
import type { AccountRef } from "../durableobjects/receivables.js";

const RESERVATION_PREFIX = "forests/index/chain-binding/";

interface ReservationJson {
  state?: string;
  r?: string;
}

export async function listRegisteredAccounts(
  bucket: R2Bucket,
): Promise<AccountRef[]> {
  const accounts: AccountRef[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: RESERVATION_PREFIX, cursor });
    for (const obj of page.objects) {
      const univocityInstanceId = obj.key.slice(RESERVATION_PREFIX.length);
      const got = await bucket.get(obj.key);
      if (!got) continue;
      let record: ReservationJson;
      try {
        record = JSON.parse(await got.text()) as ReservationJson;
      } catch {
        console.warn(
          `instance-accounts: unparseable reservation at ${obj.key}; skipped`,
        );
        continue;
      }
      if (record.state !== "registered" || !record.r) continue;
      let binding: { chainId: string; univocityAddr: string };
      try {
        binding = chainBindingFromUnivocityInstanceId(univocityInstanceId);
      } catch {
        console.warn(
          `instance-accounts: non-canonical reservation key ${univocityInstanceId}; skipped`,
        );
        continue;
      }
      accounts.push({
        univocityInstanceId,
        chainId: binding.chainId,
        univocityAddr: binding.univocityAddr,
        root: record.r,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return accounts;
}

/**
 * Read one registered account by id (slice 04: the credits settlement path
 * needs the full AccountRef — the root comes from the registry, not the job).
 * Returns null for missing, unparseable, unregistered, or non-canonical
 * records.
 */
export async function readRegisteredAccount(
  bucket: R2Bucket,
  univocityInstanceId: string,
): Promise<AccountRef | null> {
  const got = await bucket.get(`${RESERVATION_PREFIX}${univocityInstanceId}`);
  if (!got) return null;
  let record: ReservationJson;
  try {
    record = JSON.parse(await got.text()) as ReservationJson;
  } catch {
    return null;
  }
  if (record.state !== "registered" || !record.r) return null;
  let binding: { chainId: string; univocityAddr: string };
  try {
    binding = chainBindingFromUnivocityInstanceId(univocityInstanceId);
  } catch {
    return null;
  }
  return {
    univocityInstanceId,
    chainId: binding.chainId,
    univocityAddr: binding.univocityAddr,
    root: record.r,
  };
}
