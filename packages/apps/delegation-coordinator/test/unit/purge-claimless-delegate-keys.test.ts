/**
 * The slice 08 cutover data step (plan-2609-12 change 5): every
 * `delegate_keys` row whose stored voucher has no claim 4 is deleted, and no
 * other row is touched.
 */

import { randomUUID } from "node:crypto";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { shardNameForIndex } from "@canopy/forestrie-sharding";
import { base64ToBytes } from "../../src/encoding.js";
import { purgeClaimlessDelegateKeys } from "../../src/purge-claimless-delegate-keys.js";
import { freshKey, lookup } from "./delegate-keys-client.js";
import { signTestVoucher } from "./registrar-voucher-fixture.js";

function hashLike(): string {
  return randomUUID().replaceAll("-", "").repeat(2);
}

describe("purgeClaimlessDelegateKeys", () => {
  it("deletes rows without claim 4 and keeps the rest", async () => {
    const sealerId = `sealer-s08-purge-${randomUUID().slice(0, 8)}`;
    const key = freshKey().publicKey;
    const withClaim = base64ToBytes(await signTestVoucher(sealerId, 1, key));
    const claimless = base64ToBytes(
      await signTestVoucher(sealerId, 2, key, null),
    );
    const rows: Array<[string, number, Uint8Array | null]> = [
      [hashLike(), 1, withClaim],
      [hashLike(), 2, claimless],
      [hashLike(), 3, null],
      [hashLike(), 4, new Uint8Array([0x01, 0x02])],
    ];

    const stub = env.DELEGATION_STORE.get(
      env.DELEGATION_STORE.idFromName(shardNameForIndex(0)),
    );
    // Any request runs ensureSchema on every shard, so the table exists.
    await lookup("f".repeat(64));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      for (const [hash, epoch, voucher] of rows) {
        sql.exec(
          `INSERT INTO delegate_keys
             (pubkey_hash, sealer_id, alg, public_key, epoch, not_after, voucher)
           VALUES (?, ?, 'ES256', ?, ?, 4102444800, ?)`,
          hash,
          sealerId,
          key,
          epoch,
          voucher,
        );
      }

      // Other suites' rows share the store; they all carry claim 4.
      expect(purgeClaimlessDelegateKeys(sql)).toBe(3);
      const left = [
        ...sql.exec(
          `SELECT epoch FROM delegate_keys WHERE sealer_id = ?`,
          sealerId,
        ),
      ].map((r) => Number(r.epoch));
      expect(left).toEqual([1]);
      expect(purgeClaimlessDelegateKeys(sql)).toBe(0);

      sql.exec(`DELETE FROM delegate_keys WHERE sealer_id = ?`, sealerId);
    });
  });
});
