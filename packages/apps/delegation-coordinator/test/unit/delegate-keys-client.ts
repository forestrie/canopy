/**
 * Request helpers shared by the delegate-key route suites (plan-2609-12
 * slices 04 and 08). Every helper goes through the real worker with the test
 * app token, which also passes the operator-plane gate.
 */

import { randomUUID } from "node:crypto";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { delegateKeyEntryWithVoucher } from "./registrar-voucher-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

export const TEST_TOKEN = "test-coordinator-token";
export const FAR_FUTURE = 4_102_444_800; // 2100-01-01
export const BASE = "http://localhost/api/sealer/delegate-keys";
export const ADMIN_BASE = "http://localhost/admin/api/sealer/delegate-keys";
export const TOMBSTONES = `${ADMIN_BASE}/tombstones`;

/** Bearer app-token headers, merged with `extra`. */
export function appTokenHeaders(extra?: HeadersInit): HeadersInit {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

/**
 * A sealer id no other test uses: the store is shared across suites and
 * pubkey_hash is a global primary key.
 */
export function uniqueSealerId(prefix = "sealer-s04"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** A random EC2 COSE_Key (the shape the fixture's seeded keys use). */
export function freshKey(): { publicKey: Uint8Array } {
  const x = crypto.getRandomValues(new Uint8Array(32));
  const y = crypto.getRandomValues(new Uint8Array(32));
  return {
    publicKey: encodeCborDeterministic(
      new Map<number, unknown>([
        [1, 2],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    ),
  };
}

/** One key to register; `voucherNotAfter` is claim 4 (`null` omits it). */
export interface TestKey {
  publicKey: Uint8Array;
  epoch: number;
  notAfter?: number;
  voucherNotAfter?: number | null;
}

/**
 * POST /api/sealer/delegate-keys with a voucher per key.
 *
 * @param keys - Body `notAfter` defaults to {@link FAR_FUTURE}, so the stored
 *   row's not-after is the voucher's claim 4 unless a test says otherwise.
 */
export async function register(
  sealerId: string,
  keys: TestKey[],
): Promise<Response> {
  return postRegistration(await registrationBody(sealerId, keys));
}

/**
 * A registration body with freshly signed vouchers. ES256 signatures are
 * randomised, so each call yields different voucher bytes; a test repeating
 * one assertion, as the sealer does, posts the same body twice.
 */
export async function registrationBody(
  sealerId: string,
  keys: TestKey[],
): Promise<string> {
  return JSON.stringify({
    sealerId,
    keys: await Promise.all(
      keys.map((k) =>
        delegateKeyEntryWithVoucher({
          sealerId,
          publicKey: k.publicKey,
          epoch: k.epoch,
          notAfter: k.notAfter ?? FAR_FUTURE,
          voucherNotAfter: k.voucherNotAfter,
        }),
      ),
    ),
  });
}

/** POST a prepared registration body. */
export async function postRegistration(body: string): Promise<Response> {
  return fetchWithDoRetry(BASE, {
    method: "POST",
    headers: appTokenHeaders({ "Content-Type": "application/json" }),
    body,
  });
}

/** GET /api/sealer/delegate-keys/{pubkeyHash}. */
export async function lookup(pubkeyHash: string): Promise<Response> {
  return fetchWithDoRetry(`${BASE}/${pubkeyHash}`, {
    headers: appTokenHeaders(),
  });
}

/** GET /api/sealer/delegate-keys?sealerId=. */
export async function listing(sealerId: string): Promise<Response> {
  return fetchWithDoRetry(`${BASE}?sealerId=${encodeURIComponent(sealerId)}`, {
    headers: appTokenHeaders(),
  });
}
