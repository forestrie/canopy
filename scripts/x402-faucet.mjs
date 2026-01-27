#!/usr/bin/env node

/**
 * Check dev wallet USDC balance on Base Sepolia and optionally refill via CDP faucet.
 *
 * Usage:
 *   # Check balance only
 *   node scripts/x402-faucet.mjs --check
 *
 *   # Request USDC from faucet (requires CDP API credentials)
 *   node scripts/x402-faucet.mjs --refill
 *
 *   # Refill only if balance is below threshold (50% of daily claim)
 *   node scripts/x402-faucet.mjs --refill-if-low
 *
 * Environment variables:
 *   Required for all operations:
 *     CANOPY_X402_DEV_PRIVATE_KEY - Dev wallet private key (to derive address)
 *
 *   Required for --refill and --refill-if-low:
 *     CDP_API_KEY_ID     - Coinbase Developer Platform API key ID
 *     CDP_API_KEY_SECRET - Coinbase Developer Platform API key secret
 *
 *   Optional:
 *     CANOPY_X402_DEV_DAILY_CLAIM_USDC - Expected daily faucet claim (default: 100)
 *     CANOPY_X402_DEV_RPC_URL          - Base Sepolia RPC (default: https://sepolia.base.org)
 */

import process from "node:process";
import crypto from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

// Base Sepolia USDC token address
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const DEFAULT_RPC = "https://sepolia.base.org";
const DEFAULT_DAILY_CLAIM = 10; // USDC - conservative estimate for CDP faucet

// CDP API endpoint for faucet
const CDP_API_BASE = "https://api.cdp.coinbase.com";

function usage(code = 1) {
  console.error("Usage: x402-faucet.mjs [--check | --refill | --refill-if-low]");
  console.error("");
  console.error("  --check         Check balance and report");
  console.error("  --refill        Request USDC from CDP faucet");
  console.error("  --refill-if-low Refill only if balance < 50% of daily claim");
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    return { mode: "check" };
  }
  if (args.includes("--help") || args.includes("-h")) {
    usage(0);
  }
  if (args.includes("--refill-if-low")) {
    return { mode: "refill-if-low" };
  }
  if (args.includes("--refill")) {
    return { mode: "refill" };
  }
  if (args.includes("--check")) {
    return { mode: "check" };
  }
  console.error(`Unknown argument: ${args[0]}`);
  usage(1);
}

function hexToBytes(hex) {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0) {
    throw new Error("Invalid hex string length");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) {
    bytes[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

function deriveAddress(privateKey) {
  const privBytes = hexToBytes(privateKey);
  const pubKey = secp256k1.getPublicKey(privBytes, false); // uncompressed
  const hash = keccak_256(pubKey.slice(1));
  const addressBytes = hash.slice(-20);
  return bytesToHex(addressBytes);
}

async function getUsdcBalance(rpcUrl, walletAddress) {
  const addressPadded = walletAddress.replace(/^0x/, "").padStart(64, "0");
  const data = "0x70a08231" + addressPadded;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: BASE_SEPOLIA_USDC, data }, "latest"],
  });

  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`RPC request failed: ${res.status}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  const hex = json.result;
  if (!hex || hex === "0x") {
    return 0n;
  }
  return BigInt(hex);
}

/**
 * Generate JWT for CDP API authentication.
 * CDP uses ES256 (ECDSA with P-256 and SHA-256).
 */
function generateCdpJwt(keyId, keySecret, uri) {
  const header = {
    alg: "ES256",
    kid: keyId,
    typ: "JWT",
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  const now = Math.floor(Date.now() / 1000);
  // Payload format aligned with Coinbase CDP JWT docs:
  // {
  //   sub: keyId,
  //   iss: "cdp",
  //   nbf: now,
  //   exp: now + 120,
  //   uri: "POST api.cdp.coinbase.com/platform/v2/evm/faucet",
  // }
  const payload = {
    sub: keyId,
    iss: "cdp",
    nbf: now,
    exp: now + 120, // 2 minutes
    uri,
  };

  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const message = `${headerB64}.${payloadB64}`;

  let key;
  try {
    key = parseCdpPrivateKey(keySecret);
  } catch (err) {
    throw new Error(
      `Failed to parse CDP_API_KEY_SECRET as an EC private key: ${err.message}`,
    );
  }

  const signature = crypto.sign("sha256", Buffer.from(message), {
    key,
    dsaEncoding: "ieee-p1363", // 64 bytes (r || s) for ES256
  });

  const sigB64 = signature.toString("base64url");
  return `${message}.${sigB64}`;
}

/**
 * Accept a variety of CDP key secret encodings and normalize them to a
 * Node.js KeyObject.
 *
 * Supported inputs:
 * - PEM string (with real newlines or literal "\n")
 * - Base64-encoded PEM
 * - Base64-encoded PKCS#8 / SEC1 DER EC private key
 */
function parseCdpPrivateKey(keySecret) {
  // First, normalize common "\n" escaping patterns and trim whitespace.
  const normalized = keySecret.replace(/\\n/g, "\n").trim();
  const errors = [];

  // Strategy 1: treat the value as a direct PEM blob.
  try {
    if (normalized.includes("BEGIN")) {
      return crypto.createPrivateKey({
        key: normalized,
        format: "pem",
      });
    }
  } catch (err) {
    errors.push(`pem: ${err.message}`);
  }

  // Strategy 2: attempt base64 decode, then:
  // - if it decodes to PEM text, parse as PEM
  // - otherwise, try PKCS#8 / SEC1 DER encodings
  try {
    const der = Buffer.from(normalized, "base64");
    if (der.length > 0) {
      const asText = der.toString("ascii");
      if (asText.includes("BEGIN")) {
        // Looks like we were given base64-encoded PEM.
        return crypto.createPrivateKey({
          key: asText,
          format: "pem",
        });
      }

      // Try PKCS#8 first.
      try {
        return crypto.createPrivateKey({
          key: der,
          format: "der",
          type: "pkcs8",
        });
      } catch (errPkcs8) {
        errors.push(`pkcs8-der: ${errPkcs8.message}`);
      }

      // Fallback: EC private key in SEC1 ("EC PRIVATE KEY") form.
      try {
        return crypto.createPrivateKey({
          key: der,
          format: "der",
          type: "sec1",
        });
      } catch (errSec1) {
        errors.push(`sec1-der: ${errSec1.message}`);
      }
    }
  } catch (err) {
    errors.push(`base64-decode: ${err.message}`);
  }

  const detail = errors.length ? ` (${errors.join("; ")})` : "";
  throw new Error(`unsupported CDP key encoding${detail}`);
}

async function requestFaucet(address, keyId, keySecret) {
  const faucetPath = "/platform/v2/evm/faucet";
  const baseUrl = new URL(CDP_API_BASE);
  const host = baseUrl.host; // e.g. "api.cdp.coinbase.com"
  const uri = `POST ${host}${faucetPath}`;
  const url = `${baseUrl.origin}${faucetPath}`;

  const jwt = generateCdpJwt(keyId, keySecret, uri);

  const body = JSON.stringify({
    address,
    network: "base-sepolia",
    token: "usdc",
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const errMsg = json.message || json.error || text;
    throw new Error(`Faucet request failed (${res.status}): ${errMsg}`);
  }

  return json;
}

async function main() {
  const { mode } = parseArgs(process.argv);

  const privateKey = process.env.CANOPY_X402_DEV_PRIVATE_KEY;
  if (!privateKey) {
    console.error("Error: CANOPY_X402_DEV_PRIVATE_KEY is not set");
    process.exit(1);
  }

  const rpcUrl = process.env.CANOPY_X402_DEV_RPC_URL || DEFAULT_RPC;
  const dailyClaim = parseFloat(
    process.env.CANOPY_X402_DEV_DAILY_CLAIM_USDC || String(DEFAULT_DAILY_CLAIM)
  );

  let address;
  try {
    address = deriveAddress(privateKey);
  } catch (err) {
    console.error(`Error deriving address: ${err.message}`);
    process.exit(1);
  }

  console.log(`Dev wallet address: ${address}`);

  let balance;
  try {
    balance = await getUsdcBalance(rpcUrl, address);
  } catch (err) {
    console.error(`Error querying balance: ${err.message}`);
    process.exit(1);
  }

  const balanceUsdc = Number(balance) / 1e6;
  const threshold = dailyClaim * 0.5;

  console.log(`USDC balance: ${balanceUsdc.toFixed(6)} USDC`);
  console.log(`Threshold (50% of ${dailyClaim}): ${threshold.toFixed(2)} USDC`);

  if (mode === "check") {
    if (balanceUsdc < threshold) {
      console.log("Status: LOW - consider running --refill");
      process.exit(1);
    } else {
      console.log("Status: OK");
      process.exit(0);
    }
  }

  // For refill modes, check CDP credentials
  const cdpKeyId = process.env.CDP_API_KEY_ID;
  const cdpKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!cdpKeyId || !cdpKeySecret) {
    console.error("Error: CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for faucet requests");
    process.exit(1);
  }

  if (mode === "refill-if-low" && balanceUsdc >= threshold) {
    console.log("Balance is above threshold; skipping refill.");
    process.exit(0);
  }

  console.log("Requesting USDC from CDP faucet...");

  try {
    const result = await requestFaucet(address, cdpKeyId, cdpKeySecret);
    console.log("Faucet request successful!");
    if (result.transactionHash) {
      console.log(`Transaction: https://sepolia.basescan.org/tx/${result.transactionHash}`);
    } else {
      console.log("Response:", JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.error(`Faucet request failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  process.exit(1);
});
