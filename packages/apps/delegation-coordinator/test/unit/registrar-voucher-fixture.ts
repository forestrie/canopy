/**
 * Fixed test registrar voucher key + voucher signer (FOR-390 phase H).
 *
 * The public half (x||y, base64) is pinned in wrangler.jsonc as
 * PINNED_REGISTRAR_KEY, so vouchers signed here verify inside the worker.
 * Mirrors the custodian's Go voucher builder: an untagged COSE_Sign1 (ES256)
 * over the canonical claims map {1: sealerId, 2: epoch, 3: delegateKeyBytes}.
 */

import {
  encodeCborDeterministic,
  signCoseSign1Statement,
} from "@forestrie/encoding";
import { bytesToBase64 } from "../../src/encoding.js";

// Fixed P-256 key; its x||y is PINNED_REGISTRAR_KEY in wrangler.jsonc.
const REGISTRAR_JWK: JsonWebKey = {
  kty: "EC",
  crv: "P-256",
  d: "UjQopYy440FQit6ex2wzSJRD7XDSXnbGBx1dpr7vFZo",
  x: "xonMkF1EZlPkP5CRw9Y84HRs4y2jChTOdF38kuLatqw",
  y: "Qj6Wcd34PTLB5U7cq5jVdpuleiolurim72_kJV-QjWU",
  ext: true,
};

let cachedKey: CryptoKey | undefined;

async function registrarSigningKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = await crypto.subtle.importKey(
      "jwk",
      REGISTRAR_JWK,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }
  return cachedKey;
}

/** Sign a base64 voucher over (sealerId, epoch, delegateKeyBytes). */
export async function signTestVoucher(
  sealerId: string,
  epoch: number,
  delegateKeyBytes: Uint8Array,
): Promise<string> {
  const payload = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, sealerId],
      [2, epoch],
      [3, delegateKeyBytes],
    ]),
  );
  const cose = await signCoseSign1Statement(
    payload,
    new Uint8Array([0xab]),
    await registrarSigningKey(),
    { alg: -7 },
  );
  return bytesToBase64(cose);
}

/** A full RegisterDelegateKey entry (with voucher) for a test delegate key. */
export async function delegateKeyEntryWithVoucher(opts: {
  sealerId: string;
  publicKey: Uint8Array;
  epoch: number;
  notAfter: number;
}): Promise<{
  alg: string;
  publicKey: string;
  epoch: number;
  notAfter: number;
  voucher: string;
}> {
  return {
    alg: "ES256",
    publicKey: bytesToBase64(opts.publicKey),
    epoch: opts.epoch,
    notAfter: opts.notAfter,
    voucher: await signTestVoucher(opts.sealerId, opts.epoch, opts.publicKey),
  };
}
