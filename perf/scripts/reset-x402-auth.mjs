#!/usr/bin/env node
/**
 * Reset x402 auth block for performance testing.
 *
 * Derives the payer address from the private key and calls the settlement
 * worker's /admin/reset-auth endpoint to clear any auth blocks that may
 * have accumulated from previous test failures.
 *
 * Usage:
 *   CANOPY_X402_DEV_PRIVATE_KEY=... X402_SETTLEMENT_URL=... node reset-x402-auth.mjs
 *
 * Environment variables:
 *   CANOPY_X402_DEV_PRIVATE_KEY - Hex private key (with or without 0x prefix)
 *   X402_SETTLEMENT_URL - Settlement worker base URL
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

function hexToBytes(hex) {
  const cleanHex = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.slice(i * 2, i * 2 + 2), 16);
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

function deriveAddress(privateKeyHex) {
  const privateKey = hexToBytes(privateKeyHex);
  // Get uncompressed public key (65 bytes: 0x04 || x || y)
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  // Hash the public key (excluding the 0x04 prefix)
  const hash = keccak_256(publicKey.slice(1));
  // Take last 20 bytes as the address
  const addressBytes = hash.slice(-20);
  return bytesToHex(addressBytes);
}

async function main() {
  const privateKey = process.env.CANOPY_X402_DEV_PRIVATE_KEY;
  const settlementUrl = process.env.X402_SETTLEMENT_URL;

  if (!privateKey) {
    console.error("Error: CANOPY_X402_DEV_PRIVATE_KEY not set");
    process.exit(1);
  }
  if (!settlementUrl) {
    console.error("Error: X402_SETTLEMENT_URL not set");
    process.exit(1);
  }

  const payerAddress = deriveAddress(privateKey).toLowerCase();
  const authId = `local:${payerAddress}`;

  console.log(`Resetting auth block for wallet: ${payerAddress}`);
  console.log(`Auth ID: ${authId}`);
  console.log(`Settlement URL: ${settlementUrl}`);

  const response = await fetch(`${settlementUrl}/admin/reset-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ authId }),
  });

  const result = await response.json();

  if (!response.ok) {
    console.error(`Error: ${response.status} ${response.statusText}`);
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log("Auth reset result:");
  console.log(JSON.stringify(result, null, 2));

  if (result.previous === "blocked") {
    console.log("✓ Auth block was cleared");
  } else if (result.previous === "not_found") {
    console.log("✓ No auth block existed (clean state)");
  } else {
    console.log(`✓ Previous state was: ${result.previous}`);
  }
}

main().catch((err) => {
  console.error("Failed to reset auth:", err);
  process.exit(1);
});
