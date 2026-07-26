/**
 * x402 payer for e2e (plan-2607-43 slice 04): sign an EIP-3009
 * `transferWithAuthorization` against a decoded `X-PAYMENT-REQUIRED`
 * challenge and drive the credits purchase route.
 *
 * TypeScript port of the known-working `scripts/gen-x402-payment-signature.mjs`
 * signer (same EIP-712 encoding, same payload shape). The payer key is the
 * funded Base Sepolia dev wallet `CANOPY_X402_DEV_PRIVATE_KEY` — REAL (testnet)
 * money moves when a signed payment settles.
 */

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import type { APIRequestContext } from "@playwright/test";
import {
  univocityInstanceIdE2e,
  type E2eChainBinding,
} from "./onboard-token-e2e.js";

interface X402Option {
  scheme: string;
  network: string;
  payTo: string;
  asset: string;
  amount: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = Number.parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

function encodeUint256(value: bigint): Uint8Array {
  return hexToBytes(`0x${value.toString(16).padStart(64, "0")}`);
}

function encodeAddress(value: string): Uint8Array {
  const bytes = hexToBytes(value);
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return padded;
}

function hashType(typeString: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(typeString));
}

/** EIP-712 signing digest for EIP-3009 transferWithAuthorization. */
function transferWithAuthorizationDigest(args: {
  domain: {
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: string;
  };
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string;
}): Uint8Array {
  const concat = (parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.length * 32);
    parts.forEach((p, i) => out.set(p, i * 32));
    return out;
  };
  const domainSeparator = keccak_256(
    concat([
      hashType(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
      ),
      keccak_256(new TextEncoder().encode(args.domain.name)),
      keccak_256(new TextEncoder().encode(args.domain.version)),
      encodeUint256(args.domain.chainId),
      encodeAddress(args.domain.verifyingContract),
    ]),
  );
  const structHash = keccak_256(
    concat([
      hashType(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
      ),
      encodeAddress(args.from),
      encodeAddress(args.to),
      encodeUint256(args.value),
      encodeUint256(args.validAfter),
      encodeUint256(args.validBefore),
      hexToBytes(args.nonce),
    ]),
  );
  const combined = new Uint8Array(2 + 32 + 32);
  combined.set([0x19, 0x01], 0);
  combined.set(domainSeparator, 2);
  combined.set(structHash, 34);
  return keccak_256(combined);
}

function deriveAddress(privateKey: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKey), false);
  return bytesToHex(keccak_256(pub.slice(1)).slice(-20));
}

/**
 * Sign an x402 `exact` challenge. Input and output are the base64 header
 * values (`X-PAYMENT-REQUIRED` in, `X-PAYMENT` out).
 */
export function signX402PaymentE2e(
  paymentRequiredB64: string,
  privateKey: string,
): string {
  const decoded = JSON.parse(
    Buffer.from(paymentRequiredB64, "base64").toString("utf8"),
  ) as { x402Version?: number; accepts?: X402Option[] };
  const options = decoded.accepts ?? [];
  const chosen = options.find((o) => o.scheme === "exact");
  if (!chosen) {
    throw new Error("X-PAYMENT-REQUIRED has no 'exact' scheme option");
  }
  if (!chosen.extra?.name || !chosen.extra?.version) {
    throw new Error("challenge lacks EIP-712 domain name/version in extra");
  }

  const from = deriveAddress(privateKey);
  const nonce = bytesToHex(randomBytes(32));
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 600);
  const validBefore = BigInt(now + (chosen.maxTimeoutSeconds ?? 300));

  const digest = transferWithAuthorizationDigest({
    domain: {
      name: chosen.extra.name,
      version: chosen.extra.version,
      chainId: BigInt(chosen.network.split(":")[1]!),
      verifyingContract: chosen.asset,
    },
    from,
    to: chosen.payTo,
    value: BigInt(chosen.amount),
    validAfter,
    validBefore,
    nonce,
  });
  const sig = secp256k1.sign(digest, hexToBytes(privateKey), {
    prehash: false,
  });
  const sigBytes = new Uint8Array(65);
  sigBytes.set(sig.toCompactRawBytes(), 0);
  sigBytes[64] = (sig.recovery ?? 0) + 27;

  const payload = {
    x402Version: 2,
    payload: {
      authorization: {
        from,
        to: chosen.payTo,
        value: chosen.amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
      signature: bytesToHex(sigBytes),
    },
    resource: {
      url: "",
      description: "canopy credits purchase",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: chosen.network,
      asset: chosen.asset,
      amount: chosen.amount,
      payTo: chosen.payTo,
      maxTimeoutSeconds: chosen.maxTimeoutSeconds ?? 300,
      extra: chosen.extra,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/**
 * The dev payer key: `CANOPY_X402_DEV_PRIVATE_KEY` when set (a dedicated
 * payer wallet can be split out later without code change), else the
 * already-funded deployer EOA `DEPLOY_KEY` — in dev both are testnet-only
 * wallets in the same trust domain, and the payer role is gasless (EIP-3009:
 * the facilitator submits the transaction), so USDC balance is all it needs.
 */
export function x402PayerKeyE2e(): string | undefined {
  return (
    process.env.CANOPY_X402_DEV_PRIVATE_KEY?.trim() ||
    process.env.DEPLOY_KEY?.trim() ||
    undefined
  );
}

export interface CreditsPurchaseResultE2e {
  univocityInstanceId: string;
  credits: number;
  amountAtomic: string;
}

/**
 * Buy `credits` checkpoint credits for the bound instance: challenge → sign →
 * pay. Requires `CANOPY_X402_DEV_PRIVATE_KEY` (funded Base Sepolia wallet).
 * Returns the accepted (202) purchase; credits land after async settlement,
 * observable via the x402-settlement receivables admin read.
 */
export async function purchaseCreditsE2e(
  request: APIRequestContext,
  binding: E2eChainBinding,
  credits: number,
): Promise<CreditsPurchaseResultE2e> {
  const privateKey = x402PayerKeyE2e();
  if (!privateKey) {
    throw new Error(
      "CANOPY_X402_DEV_PRIVATE_KEY (or DEPLOY_KEY) is required to pay a credits challenge",
    );
  }
  const id = univocityInstanceIdE2e(binding);
  const path = `/api/payments/credits/${encodeURIComponent(id)}?credits=${credits}`;

  const challengeRes = await request.post(path);
  if (challengeRes.status() !== 402) {
    throw new Error(
      `credits challenge: expected 402, got ${challengeRes.status()}: ${(await challengeRes.text()).slice(0, 300)}`,
    );
  }
  const header = challengeRes.headers()["x-payment-required"];
  if (!header) {
    throw new Error("credits challenge: missing X-PAYMENT-REQUIRED header");
  }

  const paid = await request.post(path, {
    headers: { "X-PAYMENT": signX402PaymentE2e(header, privateKey) },
  });
  if (paid.status() !== 202) {
    throw new Error(
      `credits purchase: expected 202, got ${paid.status()}: ${(await paid.text()).slice(0, 300)}`,
    );
  }
  return (await paid.json()) as CreditsPurchaseResultE2e;
}
