/**
 * Cutover data step for voucher expiry
 * ([devdocs plan-2609-12 slice 08](https://github.com/forestrie/devdocs/blob/main/plans/plan-2609-12-delegate-key-registration-hardening/08-coordinator-voucher-enforcement.md)
 * change 5, ruling 7). From slice 08 the coordinator accepts only vouchers
 * carrying claim 4 (notAfter), and the kit will refuse a served voucher
 * without it, so a row registered before the cutover is deleted rather than
 * kept alive under the old rule. Hard cutover, no dual read: by the plan's
 * ordering every running sealer already re-asserts with a claim-4 voucher
 * once a minute, so only stale rows go and live ones return at the next
 * assertion.
 *
 * The voucher was verified at registration; this reads its claims only and
 * never re-checks the signature. Idempotent: once no claim-less row can be
 * written, every later run deletes nothing.
 */

import { decodeCborDeterministic, decodeCoseSign1 } from "@forestrie/encoding";

/**
 * Delete every `delegate_keys` row whose voucher lacks claim 4, including a
 * NULL or undecodable voucher.
 *
 * @param sql - The shard's SQLite storage; the table must exist.
 * @returns The number of rows deleted.
 */
export function purgeClaimlessDelegateKeys(sql: SqlStorage): number {
  const stale: string[] = [];
  for (const row of sql.exec(
    `SELECT pubkey_hash, voucher FROM delegate_keys`,
  )) {
    const voucher = row.voucher;
    if (!(voucher instanceof ArrayBuffer && voucherHasNotAfter(voucher))) {
      stale.push(String(row.pubkey_hash));
    }
  }
  for (const hash of stale) {
    sql.exec(`DELETE FROM delegate_keys WHERE pubkey_hash = ?`, hash);
  }
  return stale.length;
}

/** True when the voucher's claims map carries key 4. */
function voucherHasNotAfter(voucher: ArrayBuffer): boolean {
  const decoded = decodeCoseSign1(new Uint8Array(voucher));
  if (!decoded) return false;
  try {
    const claims = decodeCborDeterministic(decoded.payloadBstr);
    return claims instanceof Map && claims.has(4);
  } catch {
    return false;
  }
}
