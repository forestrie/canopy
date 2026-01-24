import { secp256k1 } from "@noble/curves/secp256k1";

import { hashPayment, type UptoPaymentFields } from "./paymentpayload";
import { bytesToHex, hexToBytes } from "./bytes";
import type { UptoPaymentConfig } from "./uptopaymentconfig";
import type { TestAccountConfig } from "./testaccountconfig";
import type { PaymentSignatureHeader } from "./paymentsignatureheader";

/**
 * Build and sign an `upto` payment payload for use in Payment-Signature
 * headers.
 */
export function buildAndSignUptoPayment(
  cfg: UptoPaymentConfig,
  account: TestAccountConfig,
): PaymentSignatureHeader {
  const nonce = cfg.nonce ?? String(Date.now());

  const payload: UptoPaymentFields = {
    scheme: "upto",
    network: cfg.network,
    payTo: cfg.payTo,
    resource: cfg.resource,
    maxAmount: cfg.maxAmount,
    minPrice: cfg.minPrice,
    nonce,
  };

  const hash = hashPayment(payload);
  const privBytes = hexToBytes(account.privateKey);
  const sig = secp256k1.sign(hash, privBytes, { prehash: false });
  const compact = sig.toCompactRawBytes();

  if (sig.recovery === undefined) {
    throw new Error("secp256k1 signature missing recovery bit");
  }

  const sigBytes = new Uint8Array(65);
  sigBytes.set(compact, 0);
  sigBytes[64] = sig.recovery & 0xff;

  const sigHex = bytesToHex(sigBytes);

  return {
    ...payload,
    sig: sigHex,
  };
}
