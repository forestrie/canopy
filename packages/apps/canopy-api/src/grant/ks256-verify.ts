/**
 * KS256 COSE Sign1 verification: Keccak-256 Sig_structure + ecrecover / ERC-1271.
 * Matches univocity `verifyKS256Raw` / `verifyDelegationProofKS256`.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { encodeFunctionData, parseAbi } from "viem";
import {
  COSE_ALG_KS256,
  decodeCoseSign1,
  encodeSigStructure,
} from "@canopy/encoding";
import type { ParsedKs256RootKey } from "./parsed-ks256-root-key.js";

const ERC1271_ABI = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const ERC1271_MAGIC = "0x1626ba7e";

export interface Ks256VerifyOptions {
  /** JSON-RPC URL for ERC-1271 `eth_call` and `eth_getCode`. */
  rpcUrl?: string;
  logFailures?: boolean;
  logPrefix?: string;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function addressFromUncompressedPubkey(uncompressed: Uint8Array): Uint8Array {
  const hash = keccak_256(uncompressed.slice(1));
  return hash.slice(-20);
}

function recoverSignerAddress(
  hash: Uint8Array,
  signature: Uint8Array,
): Uint8Array | null {
  if (signature.length !== 65) return null;
  const r = signature.slice(0, 32);
  const s = signature.slice(32, 64);
  let v = signature[64]!;
  if (v < 27) v += 27;
  const recovery = v - 27;
  if (recovery > 3) return null;
  try {
    const sig = secp256k1.Signature.fromCompact(
      new Uint8Array([...r, ...s]),
    ).addRecoveryBit(recovery);
    const pub = sig.recoverPublicKey(hash);
    return addressFromUncompressedPubkey(pub.toRawBytes(false));
  } catch {
    return null;
  }
}

async function ethRpc(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${method} failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    result?: unknown;
    error?: { message?: string };
  };
  if (json.error?.message) {
    throw new Error(json.error.message);
  }
  return json.result;
}

async function hasContractCode(
  rpcUrl: string,
  address: Uint8Array,
): Promise<boolean> {
  const result = (await ethRpc(rpcUrl, "eth_getCode", [
    `0x${bytesToHex(address)}`,
    "latest",
  ])) as string;
  if (typeof result !== "string") return false;
  const stripped = result.replace(/^0x/i, "");
  return stripped.length > 0 && !/^0+$/.test(stripped);
}

function encodeIsValidSignatureCall(
  hash: Uint8Array,
  signature: Uint8Array,
): `0x${string}` {
  const hashHex = (`0x${bytesToHex(hash)}`) as `0x${string}`;
  const sigHex = (`0x${bytesToHex(signature)}`) as `0x${string}`;
  return encodeFunctionData({
    abi: ERC1271_ABI,
    functionName: "isValidSignature",
    args: [hashHex, sigHex],
  });
}

async function verifyErc1271Signature(
  rpcUrl: string,
  signer: Uint8Array,
  hash: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const data = encodeIsValidSignatureCall(hash, signature);
  const result = (await ethRpc(rpcUrl, "eth_call", [
    { to: `0x${bytesToHex(signer)}`, data },
    "latest",
  ])) as string;
  return (
    typeof result === "string" &&
    result.toLowerCase().startsWith(ERC1271_MAGIC.toLowerCase())
  );
}

/**
 * Verify a COSE Sign1 with KS256 (Keccak Sig_structure + 65-byte eth sig).
 */
export async function verifyKs256CoseSign1(
  coseSign1Bytes: Uint8Array,
  root: ParsedKs256RootKey,
  opts?: Ks256VerifyOptions,
): Promise<boolean> {
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) {
    if (opts?.logFailures) {
      console.warn(
        JSON.stringify({
          tag: "verifyKs256Failure",
          prefix: opts.logPrefix ?? "",
          reason: "decode_failed",
        }),
      );
    }
    return false;
  }

  const sigStructure = encodeSigStructure(
    decoded.protectedBstr,
    new Uint8Array(0),
    decoded.payloadBstr,
  );
  const hash = keccak_256(sigStructure);
  const signature = decoded.signature;

  const rpcUrl = opts?.rpcUrl?.trim();
  if (rpcUrl) {
    try {
      if (await hasContractCode(rpcUrl, root.address)) {
        return verifyErc1271Signature(rpcUrl, root.address, hash, signature);
      }
    } catch (e) {
      if (opts?.logFailures) {
        console.warn(
          JSON.stringify({
            tag: "verifyKs256Failure",
            prefix: opts.logPrefix ?? "",
            reason: "erc1271_rpc_failed",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      return false;
    }
  }

  if (signature.length !== 65) {
    if (opts?.logFailures) {
      console.warn(
        JSON.stringify({
          tag: "verifyKs256Failure",
          prefix: opts.logPrefix ?? "",
          reason: "signature_wrong_length",
          signatureLen: signature.length,
        }),
      );
    }
    return false;
  }

  const recovered = recoverSignerAddress(hash, signature);
  const ok = recovered !== null && bytesEqual(recovered, root.address);
  if (!ok && opts?.logFailures) {
    console.warn(
      JSON.stringify({
        tag: "verifyKs256Failure",
        prefix: opts.logPrefix ?? "",
        reason: "ecrecover_mismatch",
      }),
    );
  }
  return ok;
}

/** Verify a delegation certificate COSE Sign1 signed by a KS256 root address. */
export async function verifyKs256DelegationCert(
  delegationCertBytes: Uint8Array,
  root: ParsedKs256RootKey,
  opts?: Ks256VerifyOptions,
): Promise<boolean> {
  return verifyKs256CoseSign1(delegationCertBytes, root, {
    ...opts,
    logPrefix: opts?.logPrefix ?? "delegation-cert-ks256",
  });
}

export { COSE_ALG_KS256 };
