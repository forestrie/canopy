#!/usr/bin/env node

/**
 * Generate a standard x402 X-PAYMENT header for POST /logs/{logId}/entries.
 *
 * This script generates EIP-3009 transferWithAuthorization signatures
 * compatible with the official x402 protocol and facilitators.
 *
 * Usage examples:
 *   # X-PAYMENT-REQUIRED via CLI arg (base64-encoded)
 *   node scripts/gen-x402-payment-signature.mjs \
 *     --payment-required "$X_PAYMENT_REQUIRED_BASE64"
 *
 *   # X-PAYMENT-REQUIRED via stdin (base64-encoded)
 *   printf '%s' "$X_PAYMENT_REQUIRED_BASE64" | \
 *     node scripts/gen-x402-payment-signature.mjs
 *
 * The script uses the dev payer key CANOPY_X402_DEV_PRIVATE_KEY (required).
 *
 * Output: base64-encoded JSON payload suitable for the X-PAYMENT header.
 *
 * Optional balance guardrail:
 *   Set CANOPY_X402_DEV_DAILY_CLAIM_USDC (e.g. "100") and CANOPY_X402_DEV_RPC_URL
 *   to enable a one-time check that warns if the dev wallet's Base Sepolia USDC
 *   balance is below 50% of the configured daily faucet claim.
 */

import process from "node:process";
import crypto from "node:crypto";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

function usage(code = 1) {
  console.error(
    "Usage: gen-x402-payment-signature.mjs [--payment-required <base64-json>]",
  );
  console.error(
    "  If --payment-required is omitted, the script reads X-PAYMENT-REQUIRED from stdin.",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    paymentRequired: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    } else if (arg === "--payment-required") {
      if (i + 1 >= args.length) {
        console.error("--payment-required requires a value");
        usage(1);
      }
      result.paymentRequired = args[++i];
    } else if (arg === "--log-id" || arg === "--scheme") {
      // Silently skip deprecated arguments for backwards compatibility.
      i++;
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage(1);
    }
  }

  return result;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", (err) => reject(err));
  });
}

async function main() {
  const { paymentRequired: prArg } = parseArgs(process.argv);

  let paymentRequiredRaw = prArg;
  if (!paymentRequiredRaw) {
    paymentRequiredRaw = await readStdin();
  }

  if (!paymentRequiredRaw) {
    console.error(
      "X-PAYMENT-REQUIRED must be provided via --payment-required or stdin",
    );
    usage(1);
  }

  // Decode base64 X-PAYMENT-REQUIRED header.
  let paymentRequiredJson;
  try {
    paymentRequiredJson = Buffer.from(paymentRequiredRaw, "base64").toString(
      "utf8",
    );
  } catch {
    console.error("X-PAYMENT-REQUIRED is not valid base64");
    process.exit(1);
  }

  let paymentRequired;
  try {
    paymentRequired = JSON.parse(paymentRequiredJson);
  } catch {
    console.error("X-PAYMENT-REQUIRED is not valid JSON after base64 decode");
    process.exit(1);
  }

  // Support both v1 (single object/array) and v2 ({ x402Version: 2, accepts: [...] }) formats.
  let options;
  if (paymentRequired.x402Version === 2 && Array.isArray(paymentRequired.accepts)) {
    // v2 format: { x402Version: 2, accepts: [...] }
    options = paymentRequired.accepts;
  } else if (Array.isArray(paymentRequired)) {
    // v1 format: array of options
    options = paymentRequired;
  } else {
    // v1 format: single option object
    options = [paymentRequired];
  }

  if (options.length === 0) {
    console.error("X-PAYMENT-REQUIRED contains no payment options");
    process.exit(1);
  }

  // Find exact scheme option.
  const chosen = options.find((o) => o.scheme === "exact");
  if (!chosen) {
    console.error("No 'exact' scheme found in X-PAYMENT-REQUIRED options");
    process.exit(1);
  }

  if (!chosen.network || !chosen.payTo || !chosen.asset || !chosen.amount) {
    console.error(
      "Chosen x402 option is missing required fields (network, payTo, asset, amount)",
    );
    process.exit(1);
  }

  const privateKey = process.env.CANOPY_X402_DEV_PRIVATE_KEY;

  if (!privateKey) {
    console.error(
      "Missing dev x402 private key: set CANOPY_X402_DEV_PRIVATE_KEY",
    );
    process.exit(1);
  }

  // Optional balance guardrail.
  await checkBalanceGuardrail(privateKey, chosen.network);

  // Build and sign EIP-3009 authorization.
  const payload = await buildAndSignExactPayment({
    network: chosen.network,
    payTo: chosen.payTo,
    asset: chosen.asset,
    amount: chosen.amount,
    maxTimeoutSeconds: chosen.maxTimeoutSeconds || 300,
    extra: chosen.extra,
    privateKey,
  });

  // Output base64-encoded JSON for X-PAYMENT header.
  const jsonPayload = JSON.stringify(payload);
  const base64Payload = Buffer.from(jsonPayload).toString("base64");
  process.stdout.write(base64Payload);
}

/**
 * Build and sign an EIP-3009 transferWithAuthorization payload.
 */
async function buildAndSignExactPayment(cfg) {
  const {
    network,
    payTo,
    asset,
    amount,
    maxTimeoutSeconds,
    extra,
    privateKey,
  } = cfg;

  // Derive payer address from private key.
  const payerAddress = deriveAddress(privateKey);

  // Create random bytes32 nonce.
  const nonceBytes = crypto.randomBytes(32);
  const nonce = bytesToHex(nonceBytes);

  // Time bounds.
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600; // 10 minutes before
  const validBefore = now + maxTimeoutSeconds;

  const authorization = {
    from: payerAddress,
    to: payTo,
    value: amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  // Sign using EIP-712.
  const chainId = parseInt(network.split(":")[1]);
  if (!extra?.name || !extra?.version) {
    throw new Error(
      `EIP-712 domain parameters (name, version) are required in payment requirements for asset ${asset}`,
    );
  }

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

  // Build the accepted requirements (what we're paying for).
  const accepted = {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds,
    extra: extra || {},
  };

  // Build resource info (what we're paying to access).
  // For statement registration, this is a placeholder - the resource URL
  // would typically come from the PaymentRequired response.
  const resource = {
    url: "",
    description: "SCRAPI statement registration",
    mimeType: "application/cose",
  };

  // Return full x402 v2 PaymentPayload structure.
  return {
    x402Version: 2,
    payload: {
      authorization,
      signature,
    },
    resource,
    accepted,
  };
}

/**
 * Sign EIP-712 typed data using secp256k1.
 * This is a minimal implementation matching viem's signTypedData.
 */
function signTypedData({ privateKey, domain, types, primaryType, message }) {
  // Build EIP-712 struct hash.
  const domainSeparator = hashStruct("EIP712Domain", domain, {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
  });

  const structHash = hashStruct(primaryType, message, types);

  // EIP-712 signing hash: keccak256("\x19\x01" || domainSeparator || structHash)
  const prefix = new Uint8Array([0x19, 0x01]);
  const combined = new Uint8Array(2 + 32 + 32);
  combined.set(prefix, 0);
  combined.set(domainSeparator, 2);
  combined.set(structHash, 34);

  const hash = keccak_256(combined);

  // Sign with secp256k1.
  const privBytes = hexToBytes(privateKey);
  const sig = secp256k1.sign(hash, privBytes, { prehash: false });
  const compact = sig.toCompactRawBytes();

  if (sig.recovery === undefined) {
    throw new Error("secp256k1 signature missing recovery bit");
  }

  // Standard Ethereum signature format: r (32) || s (32) || v (1)
  const sigBytes = new Uint8Array(65);
  sigBytes.set(compact, 0);
  sigBytes[64] = sig.recovery + 27;

  return bytesToHex(sigBytes);
}

/**
 * Hash a struct according to EIP-712.
 */
function hashStruct(typeName, data, types) {
  const encoded = encodeData(typeName, data, types);
  return keccak_256(encoded);
}

/**
 * Encode data according to EIP-712.
 */
function encodeData(typeName, data, types) {
  const typeHash = hashType(typeName, types);
  const encodedValues = [typeHash];

  for (const field of types[typeName]) {
    const value = data[field.name];
    encodedValues.push(encodeValue(field.type, value, types));
  }

  // Concatenate all 32-byte values.
  const result = new Uint8Array(encodedValues.length * 32);
  for (let i = 0; i < encodedValues.length; i++) {
    result.set(encodedValues[i], i * 32);
  }
  return result;
}

/**
 * Encode a single value according to EIP-712.
 */
function encodeValue(type, value, types) {
  if (type === "string") {
    return keccak_256(new TextEncoder().encode(value));
  }
  if (type === "bytes") {
    return keccak_256(hexToBytes(value));
  }
  if (type === "bytes32") {
    const bytes = hexToBytes(value);
    if (bytes.length !== 32) {
      throw new Error(`bytes32 value must be 32 bytes, got ${bytes.length}`);
    }
    return bytes;
  }
  if (type === "address") {
    // Address is left-padded to 32 bytes.
    const bytes = hexToBytes(value);
    const padded = new Uint8Array(32);
    padded.set(bytes, 32 - bytes.length);
    return padded;
  }
  if (type === "uint256") {
    // uint256 is big-endian, left-padded to 32 bytes.
    const bigValue = typeof value === "bigint" ? value : BigInt(value);
    const hex = bigValue.toString(16).padStart(64, "0");
    return hexToBytes("0x" + hex);
  }
  if (type === "bool") {
    const bytes = new Uint8Array(32);
    bytes[31] = value ? 1 : 0;
    return bytes;
  }
  if (types[type]) {
    // Nested struct.
    return hashStruct(type, value, types);
  }
  throw new Error(`Unsupported type: ${type}`);
}

/**
 * Hash type according to EIP-712.
 */
function hashType(typeName, types) {
  const typeString = encodeType(typeName, types);
  return keccak_256(new TextEncoder().encode(typeString));
}

/**
 * Encode type string according to EIP-712.
 */
function encodeType(typeName, types) {
  const fields = types[typeName];
  if (!fields) {
    throw new Error(`Unknown type: ${typeName}`);
  }
  const fieldStrings = fields.map((f) => `${f.type} ${f.name}`).join(",");
  return `${typeName}(${fieldStrings})`;
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

// --------------------------------------------------------------------------
// Balance guardrail: warn if dev wallet USDC balance is below 50% of daily claim
// --------------------------------------------------------------------------

// Base Sepolia USDC token address
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

// Default RPC for Base Sepolia (public, rate-limited)
const DEFAULT_BASE_SEPOLIA_RPC = "https://sepolia.base.org";

// Track whether we've already checked this process to avoid repeated RPC calls.
let balanceChecked = false;

// Default daily faucet claim estimate (conservative)
const DEFAULT_DAILY_CLAIM_USDC = 10;

async function checkBalanceGuardrail(privateKey, network) {
  // Only check once per process.
  if (balanceChecked) return;
  balanceChecked = true;

  // Only check on Base Sepolia.
  if (network !== "eip155:84532") return;

  const dailyClaimStr = process.env.CANOPY_X402_DEV_DAILY_CLAIM_USDC;
  // Use configured value or default
  const dailyClaim = dailyClaimStr
    ? parseFloat(dailyClaimStr)
    : DEFAULT_DAILY_CLAIM_USDC;
  if (isNaN(dailyClaim) || dailyClaim <= 0) {
    console.error(
      `[x402-guardrail] Invalid CANOPY_X402_DEV_DAILY_CLAIM_USDC: ${dailyClaimStr}`,
    );
    return;
  }

  const rpcUrl =
    process.env.CANOPY_X402_DEV_RPC_URL || DEFAULT_BASE_SEPOLIA_RPC;

  // Derive address from private key.
  let address;
  try {
    address = deriveAddress(privateKey);
  } catch (err) {
    console.error(
      `[x402-guardrail] Failed to derive address from private key: ${err.message}`,
    );
    return;
  }

  // Query USDC balance via eth_call (balanceOf).
  let balance;
  try {
    balance = await getUsdcBalance(rpcUrl, BASE_SEPOLIA_USDC, address);
  } catch (err) {
    // Network errors are non-fatal; just skip the check.
    console.error(
      `[x402-guardrail] Failed to query USDC balance: ${err.message}`,
    );
    return;
  }

  // USDC has 6 decimals.
  const balanceUsdc = Number(balance) / 1e6;
  const threshold = dailyClaim * 0.5;

  if (balanceUsdc < threshold) {
    console.error(
      `[x402-guardrail] WARNING: Dev wallet USDC balance (${balanceUsdc.toFixed(2)}) is below 50% of daily claim (${threshold.toFixed(2)}). Consider refilling via faucet.`,
    );

    // If strict mode is enabled, fail instead of just warning.
    if (process.env.CANOPY_X402_DEV_BALANCE_STRICT === "true") {
      console.error(
        "[x402-guardrail] CANOPY_X402_DEV_BALANCE_STRICT is set; aborting.",
      );
      process.exit(1);
    }
  }
}

function deriveAddress(privateKey) {
  const privBytes = hexToBytes(privateKey);
  const pubKey = secp256k1.getPublicKey(privBytes, false); // uncompressed
  // Address = last 20 bytes of keccak256(pubKey[1..65])
  const hash = keccak_256(pubKey.slice(1));
  const addressBytes = hash.slice(-20);
  return bytesToHex(addressBytes);
}

async function getUsdcBalance(rpcUrl, tokenAddress, walletAddress) {
  // ERC-20 balanceOf(address) selector = 0x70a08231
  // Pad wallet address to 32 bytes.
  const addressPadded = walletAddress.replace(/^0x/, "").padStart(64, "0");
  const data = "0x70a08231" + addressPadded;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [
      {
        to: tokenAddress,
        data,
      },
      "latest",
    ],
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
    throw new Error(
      `RPC error: ${json.error.message || JSON.stringify(json.error)}`,
    );
  }

  // Result is hex-encoded uint256.
  const hex = json.result;
  if (!hex || hex === "0x") {
    return 0n;
  }
  return BigInt(hex);
}

main().catch((err) => {
  console.error(
    "Error generating x402 Payment:",
    err && err.message ? err.message : err,
  );
  process.exit(1);
});
