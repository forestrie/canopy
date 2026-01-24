import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";

import {
  type PaymentPayload,
  type PaymentScheme,
  hashPayment,
} from "./paymentpayload";
import { hexToBytes, bytesToHex } from "./bytes";

export interface VerifyOptions {
  expectedNetwork: string;
  expectedResource: string;
  expectedPayTo?: `0x${string}`;
}

export type VerifyResult =
  | { ok: true; payerAddress: `0x${string}`; scheme: PaymentScheme }
  | { ok: false; error: string };

/**
 * Verify a Payment-Signature header payload and recover the payer address.
 */
export function verifyPaymentSignature(
  header: unknown,
  options: VerifyOptions,
): VerifyResult {
  if (!header || typeof header !== "object") {
    return { ok: false, error: "payment header must be an object" };
  }

  const obj = header as Record<string, unknown>;

  const scheme = obj.scheme;
  if (scheme !== "exact" && scheme !== "upto") {
    return { ok: false, error: 'scheme must be "exact" or "upto"' };
  }

  const network = stringField(obj.network);
  const payTo = stringField(obj.payTo);
  const resource = stringField(obj.resource);
  const nonce = stringField(obj.nonce);
  const sigHex = stringField(obj.sig);

  if (!network || !payTo || !resource || !nonce || !sigHex) {
    return {
      ok: false,
      error:
        "network, payTo, resource, nonce, and sig must be non-empty strings",
    };
  }

  if (network !== options.expectedNetwork) {
    return {
      ok: false,
      error: `unexpected network ${network}, expected ${options.expectedNetwork}`,
    };
  }

  if (resource !== options.expectedResource) {
    return {
      ok: false,
      error: `unexpected resource ${resource}, expected ${options.expectedResource}`,
    };
  }

  if (
    options.expectedPayTo &&
    payTo.toLowerCase() !== options.expectedPayTo.toLowerCase()
  ) {
    return {
      ok: false,
      error: `unexpected payTo ${payTo}, expected ${options.expectedPayTo}`,
    };
  }

  let payload: PaymentPayload;
  if (scheme === "upto") {
    const maxAmount = stringField(obj.maxAmount);
    const minPrice = stringField(obj.minPrice);
    if (!maxAmount || !minPrice) {
      return {
        ok: false,
        error: "upto scheme requires maxAmount and minPrice",
      };
    }
    payload = {
      scheme: "upto",
      network,
      payTo: payTo as `0x${string}`,
      resource,
      nonce,
      maxAmount,
      minPrice,
    };
  } else {
    const amount = stringField(obj.amount);
    if (!amount) {
      return { ok: false, error: "exact scheme requires amount" };
    }
    payload = {
      scheme: "exact",
      network,
      payTo: payTo as `0x${string}`,
      resource,
      nonce,
      amount,
    };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = hexToBytes(sigHex);
  } catch (e) {
    return {
      ok: false,
      error: `invalid sig hex: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (sigBytes.length !== 65) {
    return { ok: false, error: "signature must be 65 bytes (r||s||recovery)" };
  }

  const compact = sigBytes.subarray(0, 64);
  const recovery = sigBytes[64];

  const hash = hashPayment(payload);

  const signature = secp256k1.Signature.fromCompact(compact).addRecoveryBit(
    recovery,
  );

  let publicKey: Uint8Array;
  try {
    publicKey = signature.recoverPublicKey(hash).toRawBytes(false);
  } catch (e) {
    return {
      ok: false,
      error: `failed to recover public key: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    return { ok: false, error: "unexpected public key format" };
  }

  const addressBytes = keccak_256(publicKey.subarray(1)).slice(-20);
  const payerAddress = bytesToHex(addressBytes) as `0x${string}`;

  return {
    ok: true,
    payerAddress,
    scheme,
  };
}

function stringField(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
