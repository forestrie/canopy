#!/usr/bin/env node

/**
 * Generate a real x402 Payment-Signature header for POST /logs/{logId}/entries.
 *
 * Usage examples:
 *   # Payment-Required via CLI arg
 *   node scripts/gen-x402-payment-signature.mjs \
 *     --payment-required "$PAYMENT_REQUIRED" \
 *     --log-id "$LOG_ID"
 *
 *   # Payment-Required via stdin
 *   printf '%s' "$PAYMENT_REQUIRED" | \
 *     node scripts/gen-x402-payment-signature.mjs --log-id "$LOG_ID"
 *
 *   # Force exact scheme instead of default upto
 *   node scripts/gen-x402-payment-signature.mjs \
 *     --payment-required "$PAYMENT_REQUIRED" \
 *     --log-id "$LOG_ID" \
 *     --scheme exact
 *
 * The script prefers the `upto` scheme when available, but allows forcing
 * `exact` via --scheme or an env var. It uses the shared dev payer key
 * CANOPY_X402_DEV_PRIVATE_KEY by default, with optional per-tool overrides
 * such as SCRAPI_X402_PRIVATE_KEY or CANOPY_PERF_X402_PRIVATE_KEY.
 *
 * Optional balance guardrail:
 *   Set CANOPY_X402_DEV_DAILY_CLAIM_USDC (e.g. "100") and CANOPY_X402_DEV_RPC_URL
 *   to enable a one-time check that warns if the dev wallet's Base Sepolia USDC
 *   balance is below 50% of the configured daily faucet claim.
 */

import process from "node:process";

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";

function usage(code = 1) {
  console.error(
    "Usage: gen-x402-payment-signature.mjs --log-id <logId> [--payment-required <json>] [--scheme upto|exact]",
  );
  console.error(
    "  If --payment-required is omitted, the script reads Payment-Required JSON from stdin.",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    paymentRequired: null,
    logId: null,
    scheme: null,
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
    } else if (arg === "--log-id") {
      if (i + 1 >= args.length) {
        console.error("--log-id requires a value");
        usage(1);
      }
      result.logId = args[++i];
    } else if (arg === "--scheme") {
      if (i + 1 >= args.length) {
        console.error("--scheme requires a value");
        usage(1);
      }
      const scheme = args[++i];
      if (scheme !== "upto" && scheme !== "exact") {
        console.error("--scheme must be 'upto' or 'exact'");
        usage(1);
      }
      result.scheme = scheme;
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
  const { paymentRequired: prArg, logId, scheme: schemeArg } = parseArgs(
    process.argv,
  );

  if (!logId) {
    console.error("--log-id is required");
    usage(1);
  }

  let paymentRequiredRaw = prArg;
  if (!paymentRequiredRaw) {
    paymentRequiredRaw = await readStdin();
  }

  if (!paymentRequiredRaw) {
    console.error("Payment-Required JSON must be provided via --payment-required or stdin");
    usage(1);
  }

  let paymentRequired;
  try {
    paymentRequired = JSON.parse(paymentRequiredRaw);
  } catch {
    console.error("Payment-Required is not valid JSON");
    process.exit(1);
  }

  const options = (paymentRequired && paymentRequired.options) || [];
  if (!Array.isArray(options) || options.length === 0) {
    console.error("Payment-Required.options is empty or invalid");
    process.exit(1);
  }

  // Resolve scheme preference: CLI flag > env > default (upto-first).
  const envScheme = process.env.SCRAPI_X402_SCHEME || process.env.CANOPY_X402_DEV_SCHEME;
  const requestedScheme = schemeArg || envScheme || "upto";

  function chooseOption() {
    if (requestedScheme === "upto") {
      const upto = options.find((o) => o.scheme === "upto");
      if (upto) return upto;
      // Fall back to exact if upto not available.
      return options[0];
    }
    // requestedScheme === "exact"
    const exact = options.find((o) => o.scheme === "exact");
    if (exact) return exact;
    // Fall back to first option if exact not available.
    return options[0];
  }

  const chosen = chooseOption();
  if (!chosen || !chosen.network || !chosen.payTo) {
    console.error("Chosen x402 option is missing network or payTo");
    process.exit(1);
  }

  const resource = "POST /logs/{logId}/entries";

  // Determine dev private key: shared default with optional per-tool overrides.
  const privateKey =
    process.env.SCRAPI_X402_PRIVATE_KEY ||
    process.env.CANOPY_PERF_X402_PRIVATE_KEY ||
    process.env.CANOPY_X402_DEV_PRIVATE_KEY;

  if (!privateKey) {
    console.error(
      "Missing dev x402 private key: set CANOPY_X402_DEV_PRIVATE_KEY (or SCRAPI_X402_PRIVATE_KEY / CANOPY_PERF_X402_PRIVATE_KEY)",
    );
    process.exit(1);
  }

  // Optional balance guardrail: check USDC balance against 50% of daily claim.
  await checkBalanceGuardrail(privateKey, chosen.network);

  const schemeUsed = chosen.scheme === "exact" || requestedScheme === "exact"
    ? "exact"
    : "upto";

  let header;
  if (schemeUsed === "upto") {
    const minPrice = chosen.minPrice || chosen.price;
    if (!chosen.price || !minPrice) {
      console.error("upto option missing price or minPrice");
      process.exit(1);
    }

    header = buildAndSignUptoPaymentLocal({
      network: chosen.network,
      payTo: chosen.payTo,
      resource,
      maxAmount: chosen.price,
      minPrice,
      privateKey,
    });
  } else {
    // exact scheme: reuse the same underlying payload shape but with
    // maxAmount = amount = chosen.price and minPrice = chosen.price.
    const amount = chosen.price;
    if (!amount) {
      console.error("exact option missing price/amount");
      process.exit(1);
    }

    header = buildAndSignUptoPaymentLocal({
      network: chosen.network,
      payTo: chosen.payTo,
      resource,
      maxAmount: amount,
      minPrice: amount,
      privateKey,
    });
  }

  process.stdout.write(JSON.stringify(header));
}

/**
 * Local implementation of the upto-payment signing logic, mirroring the
 * @canopy/x402-signing implementation but in pure JS for Node CLI use.
 */
function buildAndSignUptoPaymentLocal(cfg) {
  const { network, payTo, resource, maxAmount, minPrice, privateKey } = cfg;
  const nonce = String(Date.now());

  const payload = {
    scheme: "upto",
    network,
    payTo,
    resource,
    maxAmount,
    minPrice,
    nonce,
  };

  const message = serializePaymentForSigning(payload);
  const hash = keccak_256(message);

  const privBytes = hexToBytes(privateKey);
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

function serializePaymentForSigning(payload) {
  const parts = [
    "x402-canopy-payment",
    `scheme:${payload.scheme}`,
    `network:${payload.network}`,
    `payTo:${payload.payTo}`,
    `resource:${payload.resource}`,
    `nonce:${payload.nonce}`,
    `maxAmount:${payload.maxAmount}`,
    `minPrice:${payload.minPrice}`,
  ];

  const encoder = new TextEncoder();
  return encoder.encode(parts.join("|"));
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
    throw new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`);
  }

  // Result is hex-encoded uint256.
  const hex = json.result;
  if (!hex || hex === "0x") {
    return 0n;
  }
  return BigInt(hex);
}

main().catch((err) => {
  console.error("Error generating x402 Payment-Signature:", err && err.message
    ? err.message
    : err);
  process.exit(1);
});
