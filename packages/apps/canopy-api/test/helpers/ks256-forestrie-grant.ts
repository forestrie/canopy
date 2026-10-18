/**
 * KS256 Forestrie-Grant statements and a mocked ERC-1271 RPC for tests.
 *
 * The grant envelope is the custodian profile (payload = SHA-256(grant v0
 * CBOR), grant in unprotected -65538) with protected `alg` -65799 and a 65-byte
 * Ethereum signature over `keccak256(Sig_structure)`, the digest canopy's
 * `verifyKs256CoseSign1`, arbor's sealer and univocity all use. Keys are
 * generated per test; nothing here is a captured fixture.
 */

import {
  encodeCborDeterministic,
  encodeCoseSign1Raw,
  encodeSigStructure,
} from "@forestrie/encoding";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { COSE_ALG_KS256 } from "../../src/cose/cose-key.js";
import { encodeGrantPayload } from "../../src/grant/codec.js";
import type { Grant } from "../../src/grant/types.js";
import {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
} from "../../src/grant/transparent-statement.js";

/** ERC-1271 `isValidSignature(bytes32,bytes)` selector and magic value. */
const ERC1271_MAGIC = "1626ba7e";

/** A fresh secp256k1 key and its Ethereum address. */
export interface Ks256TestKey {
  secretKey: Uint8Array;
  address: Uint8Array;
}

export function generateKs256TestKey(): Ks256TestKey {
  const secretKey = secp256k1.utils.randomPrivateKey();
  return { secretKey, address: addressOfSecretKey(secretKey) };
}

function addressOfSecretKey(secretKey: Uint8Array): Uint8Array {
  const pub = secp256k1.getPublicKey(secretKey, false);
  return keccak_256(pub.slice(1)).slice(-20);
}

/** `Forestrie-Grant <base64>` for a KS256-signed custodian-profile grant. */
export function ks256ForestrieGrantAuthorization(
  grant: Grant,
  key: Ks256TestKey,
): string {
  const bytes = encodeKs256ForestrieGrant(grant, key);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return `Forestrie-Grant ${btoa(s)}`;
}

function encodeKs256ForestrieGrant(
  grant: Grant,
  key: Ks256TestKey,
): Uint8Array {
  const grantPayload = encodeGrantPayload(grant);
  const digest = sha256(grantPayload);
  const protectedInner = encodeCborDeterministic(
    new Map<number, unknown>([[1, COSE_ALG_KS256]]),
  );
  const hash = keccak_256(
    encodeSigStructure(protectedInner, new Uint8Array(0), digest),
  );
  const unprot = new Map<number, Uint8Array>([
    [HEADER_IDTIMESTAMP, new Uint8Array(8)],
    [HEADER_FORESTRIE_GRANT_V0, grantPayload],
  ]);
  return encodeCoseSign1Raw(
    protectedInner,
    unprot,
    digest,
    signEthereum(hash, key.secretKey),
  );
}

/** 65-byte `r‖s‖v` signature (v = 27 + recovery) over a 32-byte hash. */
function signEthereum(hash: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(hash, secretKey);
  const out = new Uint8Array(65);
  out.set(sig.toCompactRawBytes(), 0);
  out[64] = 27 + sig.recovery;
  return out;
}

function recoverAddress(hash: Uint8Array, sig65: Uint8Array): Uint8Array {
  const v = sig65[64]! >= 27 ? sig65[64]! - 27 : sig65[64]!;
  const pub = secp256k1.Signature.fromCompact(sig65.slice(0, 64))
    .addRecoveryBit(v)
    .recoverPublicKey(hash);
  return keccak_256(pub.toRawBytes(false).slice(1)).slice(-20);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A JSON-RPC responder standing in for a chain with one 1-of-1 Safe-like
 * contract at `contract`: `eth_getCode` is non-empty there, and
 * `isValidSignature` returns the magic value iff the signature recovers to
 * `owner`. Every other address is an EOA.
 */
export function mockErc1271Rpc(opts: {
  contract: Uint8Array;
  owner: Uint8Array;
}): (body: { method: string; params: unknown[] }) => unknown {
  const contractHex = toHex(opts.contract);
  return ({ method, params }) => {
    if (method === "eth_getCode") {
      const addr = String(params[0]).replace(/^0x/, "").toLowerCase();
      return addr === contractHex ? "0x6080604052" : "0x";
    }
    if (method === "eth_call") {
      const call = params[0] as { to: string; data: string };
      if (call.to.replace(/^0x/, "").toLowerCase() !== contractHex) return "0x";
      const data = call.data.replace(/^0x/, "");
      // selector ‖ hash ‖ offset ‖ length ‖ signature (ABI-encoded bytes)
      const hash = hexToBytes(data.slice(8, 72));
      const len = parseInt(data.slice(136, 200), 16);
      const sig = hexToBytes(data.slice(200, 200 + len * 2));
      const ok =
        sig.length === 65 &&
        toHex(recoverAddress(hash, sig)) === toHex(opts.owner);
      return `0x${(ok ? ERC1271_MAGIC : "ffffffff").padEnd(64, "0")}`;
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
}
