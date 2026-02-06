#!/usr/bin/env node
/**
 * Pre-generate x402 payment signatures for k6 performance testing.
 *
 * Generates a pool of EIP-3009 transferWithAuthorization signatures that can
 * be loaded by k6 as a SharedArray. Node.js is ~100x faster than k6's goja
 * runtime for secp256k1 signing.
 *
 * Usage:
 *   CANOPY_PERF_BASE_URL=... \
 *   CANOPY_PERF_API_TOKEN=... \
 *   CANOPY_PERF_LOG_ID=... \
 *   CANOPY_X402_DEV_PRIVATE_KEY=... \
 *   CANOPY_PERF_POOL_SIZE=... \
 *   CANOPY_PERF_VALIDITY_SECONDS=... \
 *   node generate-x402-payment-pool.mjs
 *
 * Output: perf/k6/canopy-api/data/x402-payment-pool.json
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configuration from environment
const BASE_URL = process.env.CANOPY_PERF_BASE_URL;
const API_TOKEN = process.env.CANOPY_PERF_API_TOKEN;
const LOG_ID = process.env.CANOPY_PERF_LOG_ID;
const PRIVATE_KEY = process.env.CANOPY_X402_DEV_PRIVATE_KEY;
const POOL_SIZE = parseInt(process.env.CANOPY_PERF_POOL_SIZE || "10000", 10);
const VALIDITY_SECONDS = parseInt(
  process.env.CANOPY_PERF_VALIDITY_SECONDS || "900",
  10,
);

if (!BASE_URL || !API_TOKEN || !LOG_ID || !PRIVATE_KEY) {
  console.error("Required environment variables:");
  console.error("  CANOPY_PERF_BASE_URL");
  console.error("  CANOPY_PERF_API_TOKEN");
  console.error("  CANOPY_PERF_LOG_ID");
  console.error("  CANOPY_X402_DEV_PRIVATE_KEY");
  process.exit(1);
}

// Utility functions
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

function deriveAddress(privateKey) {
  const privBytes = hexToBytes(privateKey);
  const pubKey = secp256k1.getPublicKey(privBytes, false);
  const hash = keccak_256(pubKey.slice(1));
  const addressBytes = hash.slice(-20);
  return bytesToHex(addressBytes);
}

function generateRandomNonce() {
  return bytesToHex(randomBytes(32));
}

function stringToBytes(str) {
  return new TextEncoder().encode(str);
}

// EIP-712 signing
function signTypedData({ privateKey, domain, types, primaryType, message }) {
  const domainSeparator = hashStruct("EIP712Domain", domain, {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  });

  const structHash = hashStruct(primaryType, message, types);

  const prefix = new Uint8Array([0x19, 0x01]);
  const combined = new Uint8Array(2 + 32 + 32);
  combined.set(prefix, 0);
  combined.set(domainSeparator, 2);
  combined.set(structHash, 34);

  const hash = keccak_256(combined);

  const privBytes = hexToBytes(privateKey);
  const sig = secp256k1.sign(hash, privBytes, { prehash: false });
  const compact = sig.toCompactRawBytes();

  const sigBytes = new Uint8Array(65);
  sigBytes.set(compact, 0);
  sigBytes[64] = sig.recovery + 27;

  return bytesToHex(sigBytes);
}

function hashStruct(typeName, data, types) {
  const encoded = encodeData(typeName, data, types);
  return keccak_256(encoded);
}

function encodeData(typeName, data, types) {
  const typeHash = hashType(typeName, types);
  const encodedValues = [typeHash];

  for (const field of types[typeName]) {
    const value = data[field.name];
    encodedValues.push(encodeValue(field.type, value, types));
  }

  const result = new Uint8Array(encodedValues.length * 32);
  for (let i = 0; i < encodedValues.length; i++) {
    result.set(encodedValues[i], i * 32);
  }
  return result;
}

function encodeValue(type, value, types) {
  if (type === "string") {
    return keccak_256(stringToBytes(value));
  }
  if (type === "bytes32") {
    const bytes = hexToBytes(value);
    if (bytes.length !== 32) {
      throw new Error(`bytes32 value must be 32 bytes, got ${bytes.length}`);
    }
    return bytes;
  }
  if (type === "address") {
    const bytes = hexToBytes(value);
    const padded = new Uint8Array(32);
    padded.set(bytes, 32 - bytes.length);
    return padded;
  }
  if (type === "uint256") {
    const bigValue = typeof value === "bigint" ? value : BigInt(value);
    const hex = bigValue.toString(16).padStart(64, "0");
    return hexToBytes("0x" + hex);
  }
  if (types[type]) {
    return hashStruct(type, value, types);
  }
  throw new Error(`Unsupported type: ${type}`);
}

function hashType(typeName, types) {
  const typeString = encodeType(typeName, types);
  return keccak_256(stringToBytes(typeString));
}

function encodeType(typeName, types) {
  const fields = types[typeName];
  const fieldStrings = fields.map((f) => `${f.type} ${f.name}`).join(",");
  return `${typeName}(${fieldStrings})`;
}

// Fetch payment requirements from API
async function getPaymentRequirements(baseUrl, logId, apiToken) {
  const url = `${baseUrl}/logs/${logId}/entries`;

  // Make a request without payment to get the 402 response
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/cose",
    },
    body: new Uint8Array([0]), // Minimal body to trigger 402
  });

  if (response.status !== 402) {
    throw new Error(`Expected 402, got ${response.status}`);
  }

  const paymentRequired = response.headers.get("X-Payment-Required");
  if (!paymentRequired) {
    throw new Error("No X-Payment-Required header in 402 response");
  }

  return paymentRequired;
}

function parsePaymentRequirements(base64Value) {
  const jsonStr = Buffer.from(base64Value, "base64").toString("utf-8");
  const paymentRequired = JSON.parse(jsonStr);

  let options;
  if (
    paymentRequired.x402Version === 2 &&
    Array.isArray(paymentRequired.accepts)
  ) {
    options = paymentRequired.accepts;
  } else if (Array.isArray(paymentRequired)) {
    options = paymentRequired;
  } else {
    options = [paymentRequired];
  }

  const chosen = options.find((o) => o.scheme === "exact");
  if (!chosen) {
    throw new Error("No 'exact' scheme found in X-PAYMENT-REQUIRED options");
  }

  return chosen;
}

// Generate a single payment
function generatePayment(paymentOption, privateKey, validAfter, validBefore) {
  const { network, payTo, asset, amount, extra } = paymentOption;

  const payerAddress = deriveAddress(privateKey);
  const chainId = parseInt(network.split(":")[1]);
  const nonce = generateRandomNonce();

  const authorization = {
    from: payerAddress,
    to: payTo,
    value: amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  const signature = signTypedData({
    privateKey,
    domain: {
      name: extra.name,
      version: extra.version,
      chainId,
      verifyingContract: asset,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: payerAddress,
      to: payTo,
      value: BigInt(amount),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  const accepted = {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: validBefore - validAfter,
    extra: extra || {},
  };

  const resource = {
    url: "",
    description: "SCRAPI statement registration",
    mimeType: "application/cose",
  };

  const payload = {
    x402Version: 2,
    payload: {
      authorization,
      signature,
    },
    resource,
    accepted,
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

async function main() {
  console.log("Fetching payment requirements...");
  const paymentRequiredBase64 = await getPaymentRequirements(
    BASE_URL,
    LOG_ID,
    API_TOKEN,
  );
  const paymentOption = parsePaymentRequirements(paymentRequiredBase64);
  console.log(`  Amount: ${paymentOption.amount}`);
  console.log(`  Pay to: ${paymentOption.payTo}`);
  console.log(`  Asset: ${paymentOption.asset}`);

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600; // 10 min before
  const validBefore = now + VALIDITY_SECONDS;

  console.log(`Generating ${POOL_SIZE} payments...`);
  console.log(`  Validity: ${VALIDITY_SECONDS}s (until ${new Date(validBefore * 1000).toISOString()})`);

  const startTime = Date.now();
  const payments = [];

  for (let i = 0; i < POOL_SIZE; i++) {
    payments.push(generatePayment(paymentOption, PRIVATE_KEY, validAfter, validBefore));

    if ((i + 1) % 1000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = ((i + 1) / parseFloat(elapsed)).toFixed(0);
      console.log(`  Generated ${i + 1}/${POOL_SIZE} (${rate}/s)`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Generated ${POOL_SIZE} payments in ${elapsed}s`);

  // Write to file
  const outputDir = join(__dirname, "..", "k6", "canopy-api", "data");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "x402-payment-pool.json");

  writeFileSync(outputPath, JSON.stringify(payments));
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
