/**
 * x402 payment signature generation for k6.
 *
 * Generates EIP-3009 transferWithAuthorization signatures for x402 payments.
 * This is a k6-compatible port of the signing logic from
 * scripts/gen-x402-payment-signature.mjs.
 *
 * Dependencies (bundled via esbuild):
 * - @noble/curves/secp256k1
 * - @noble/hashes/sha3
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { stringToBytes } from "./cbor.js";

/**
 * Parse payment requirements from base64-encoded header value.
 *
 * @param {string} base64Value - Base64-encoded X-PAYMENT-REQUIRED header
 * @returns {Object} - Parsed payment option with scheme "exact"
 */
export function parsePaymentRequirements(base64Value) {
  // Decode base64 to JSON string
  const jsonStr = base64Decode(base64Value);
  const paymentRequired = JSON.parse(jsonStr);

  // Support both v1 and v2 formats
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

  // Find exact scheme option
  const chosen = options.find((o) => o.scheme === "exact");
  if (!chosen) {
    throw new Error("No 'exact' scheme found in X-PAYMENT-REQUIRED options");
  }

  if (!chosen.network || !chosen.payTo || !chosen.asset || !chosen.amount) {
    throw new Error(
      "Chosen x402 option is missing required fields (network, payTo, asset, amount)",
    );
  }

  return chosen;
}

/**
 * Generate a pool of x402 payment signatures for batch use.
 *
 * Pre-generates multiple payment signatures to avoid per-request signing overhead.
 * Each signature has a unique nonce and shares the same validity window.
 *
 * @param {Object} paymentOption - Parsed payment option from parsePaymentRequirements
 * @param {string} privateKey - Hex-encoded private key (with or without 0x prefix)
 * @param {number} count - Number of payments to generate
 * @param {number} validitySeconds - How long payments should be valid (from now)
 * @returns {string[]} - Array of base64-encoded X-PAYMENT header values
 */
export function generateX402PaymentPool(
  paymentOption,
  privateKey,
  count,
  validitySeconds,
) {
  const { network, payTo, asset, amount, extra } = paymentOption;

  // Derive payer address once
  const payerAddress = deriveAddress(privateKey);
  const chainId = parseInt(network.split(":")[1]);

  if (!extra?.name || !extra?.version) {
    throw new Error(
      `EIP-712 domain parameters (name, version) are required for asset ${asset}`,
    );
  }

  // Pre-compute domain and types (reused for all signatures)
  const domain = {
    name: extra.name,
    version: extra.version,
    chainId,
    verifyingContract: asset,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  // Shared time bounds for all payments in the pool
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600; // 10 minutes before
  const validBefore = now + validitySeconds;

  // Pre-compute accepted and resource (same for all)
  const accepted = {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: validitySeconds,
    extra: extra || {},
  };
  const resource = {
    url: "",
    description: "SCRAPI statement registration",
    mimeType: "application/cose",
  };

  const pool = [];
  for (let i = 0; i < count; i++) {
    // Each payment needs a unique nonce
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
      domain,
      types,
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

    const payload = {
      x402Version: 2,
      payload: {
        authorization,
        signature,
      },
      resource,
      accepted,
    };

    pool.push(base64Encode(JSON.stringify(payload)));
  }

  return pool;
}

/**
 * Generate a fresh x402 payment signature.
 *
 * @param {Object} paymentOption - Parsed payment option from parsePaymentRequirements
 * @param {string} privateKey - Hex-encoded private key (with or without 0x prefix)
 * @returns {string} - Base64-encoded X-PAYMENT header value
 */
export function generateX402Payment(paymentOption, privateKey) {
  const { network, payTo, asset, amount, maxTimeoutSeconds, extra } =
    paymentOption;

  // Derive payer address from private key
  const payerAddress = deriveAddress(privateKey);

  // Create random bytes32 nonce
  const nonce = generateRandomNonce();

  // Time bounds
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 600; // 10 minutes before
  const validBefore = now + (maxTimeoutSeconds || 300);

  const authorization = {
    from: payerAddress,
    to: payTo,
    value: amount,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };

  // Sign using EIP-712
  const chainId = parseInt(network.split(":")[1]);
  if (!extra?.name || !extra?.version) {
    throw new Error(
      `EIP-712 domain parameters (name, version) are required for asset ${asset}`,
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

  // Build accepted requirements
  const accepted = {
    scheme: "exact",
    network,
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: maxTimeoutSeconds || 300,
    extra: extra || {},
  };

  // Build resource info
  const resource = {
    url: "",
    description: "SCRAPI statement registration",
    mimeType: "application/cose",
  };

  // Build full x402 v2 PaymentPayload
  const payload = {
    x402Version: 2,
    payload: {
      authorization,
      signature,
    },
    resource,
    accepted,
  };

  // Return base64-encoded JSON
  return base64Encode(JSON.stringify(payload));
}

/**
 * Derive Ethereum address from private key.
 */
function deriveAddress(privateKey) {
  const privBytes = hexToBytes(privateKey);
  const pubKey = secp256k1.getPublicKey(privBytes, false); // uncompressed
  // Address = last 20 bytes of keccak256(pubKey[1..65])
  const hash = keccak_256(pubKey.slice(1));
  const addressBytes = hash.slice(-20);
  return bytesToHex(addressBytes);
}

/**
 * Generate a random 32-byte nonce as hex string.
 */
function generateRandomNonce() {
  // k6 doesn't have crypto.randomBytes, use Math.random
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytesToHex(bytes);
}

/**
 * Sign EIP-712 typed data using secp256k1.
 */
function signTypedData({ privateKey, domain, types, primaryType, message }) {
  // Build EIP-712 struct hash
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

  // Sign with secp256k1
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

  // Concatenate all 32-byte values
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
    return keccak_256(stringToBytes(value));
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
    // Address is left-padded to 32 bytes
    const bytes = hexToBytes(value);
    const padded = new Uint8Array(32);
    padded.set(bytes, 32 - bytes.length);
    return padded;
  }
  if (type === "uint256") {
    // uint256 is big-endian, left-padded to 32 bytes
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
    // Nested struct
    return hashStruct(type, value, types);
  }
  throw new Error(`Unsupported type: ${type}`);
}

/**
 * Hash type according to EIP-712.
 */
function hashType(typeName, types) {
  const typeString = encodeType(typeName, types);
  return keccak_256(stringToBytes(typeString));
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

/**
 * Convert hex string to bytes.
 */
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

/**
 * Convert bytes to hex string.
 */
function bytesToHex(bytes) {
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

// Base64 alphabet
const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Decode a "binary string" (where each char is a byte) to UTF-8 string.
 * This is needed because atob() returns bytes as characters, but if the
 * original data was UTF-8 encoded, we need to decode those bytes.
 */
function binaryStringToUtf8(binaryStr) {
  // Convert binary string to byte array
  const bytes = [];
  for (let i = 0; i < binaryStr.length; i++) {
    bytes.push(binaryStr.charCodeAt(i));
  }

  // Decode UTF-8 bytes to string
  let result = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      // Single byte (ASCII)
      result += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      // Two bytes
      const b1 = bytes[i++];
      result += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if ((b0 & 0xf0) === 0xe0) {
      // Three bytes
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      result += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f),
      );
    } else if ((b0 & 0xf8) === 0xf0) {
      // Four bytes (surrogate pair)
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      const codePoint =
        ((b0 & 0x07) << 18) |
        ((b1 & 0x3f) << 12) |
        ((b2 & 0x3f) << 6) |
        (b3 & 0x3f);
      // Convert to surrogate pair
      const adjusted = codePoint - 0x10000;
      result += String.fromCharCode(
        0xd800 + (adjusted >> 10),
        0xdc00 + (adjusted & 0x3ff),
      );
    }
  }
  return result;
}

/**
 * Base64 decode (k6 compatible, no Buffer dependency).
 * Returns UTF-8 decoded string.
 */
function base64Decode(str) {
  let binaryStr;

  // k6's goja runtime has atob
  if (typeof atob === "function") {
    binaryStr = atob(str);
  } else {
    // Manual base64 decode for environments without atob
    binaryStr = "";
    const input = str.replace(/=+$/, "");

    for (let i = 0; i < input.length; ) {
      const a = B64_CHARS.indexOf(input[i++]);
      const b = i < input.length ? B64_CHARS.indexOf(input[i++]) : 0;
      const c = i < input.length ? B64_CHARS.indexOf(input[i++]) : -1;
      const d = i < input.length ? B64_CHARS.indexOf(input[i++]) : -1;

      // Only use valid indices for the triplet
      const triplet =
        (a << 18) | (b << 12) | (c >= 0 ? c << 6 : 0) | (d >= 0 ? d : 0);

      binaryStr += String.fromCharCode((triplet >> 16) & 0xff);
      if (c >= 0) binaryStr += String.fromCharCode((triplet >> 8) & 0xff);
      if (d >= 0) binaryStr += String.fromCharCode(triplet & 0xff);
    }
  }

  // Decode UTF-8 bytes to string
  return binaryStringToUtf8(binaryStr);
}

/**
 * Encode a UTF-8 string to bytes, then to binary string for btoa.
 */
function utf8ToBinaryString(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);

    // Handle surrogate pairs
    if (code >= 0xd800 && code < 0xdc00 && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xdc00 && low < 0xe000) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }

    if (code < 0x80) {
      result += String.fromCharCode(code);
    } else if (code < 0x800) {
      result += String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      result += String.fromCharCode(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      result += String.fromCharCode(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return result;
}

/**
 * Base64 encode (k6 compatible, no Buffer dependency).
 * Encodes UTF-8 string to base64.
 */
function base64Encode(str) {
  // First encode string to UTF-8 bytes as binary string
  const binaryStr = utf8ToBinaryString(str);

  // k6's goja runtime has btoa
  if (typeof btoa === "function") {
    return btoa(binaryStr);
  }

  // Manual base64 encode for environments without btoa
  let result = "";
  const bytes = [];
  for (let i = 0; i < binaryStr.length; i++) {
    bytes.push(binaryStr.charCodeAt(i));
  }

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    result += B64_CHARS[b0 >> 2];
    result += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    result += b1 !== undefined ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    result += b2 !== undefined ? B64_CHARS[b2 & 63] : "=";
  }

  return result;
}
