/**
 * Validates runner-submitted BYOK delegation material before persistence.
 * Mirrors arbor delegationcert rules for payload field 5 (integer-key COSE_Key).
 */

import { decode, Decoder } from "cbor-x";
import { encodeSigStructure } from "@canopy/encoding";
import { keccak_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import { encodeFunctionData, parseAbi } from "viem";

const PAYLOAD_LOG_ID = 1;
const PAYLOAD_MMR_START = 3;
const PAYLOAD_MMR_END = 4;
const PAYLOAD_DELEGATED_KEY = 5;

const COSE_KTY = 1;
const COSE_CRV = -1;
const COSE_X = -2;
const COSE_Y = -3;
const COSE_KTY_EC2 = 2;
const COSE_CRV_P256 = 1;

const COSE_ALG_KS256 = -65799;

const intKeyDecoder = new Decoder({ mapsAsObjects: false });

const ERC1271_ABI = parseAbi([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const ERC1271_MAGIC = "0x1626ba7e";

export interface PublicRootEs256 {
  alg: "ES256";
  x: Uint8Array;
  y: Uint8Array;
}

export interface PublicRootKs256 {
  alg: "KS256";
  key: Uint8Array;
}

export type PublicRootMaterial = PublicRootEs256 | PublicRootKs256;

/** @deprecated use PublicRootMaterial */
export type PublicRootXY = PublicRootEs256;

export class ByokMaterialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByokMaterialValidationError";
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function bytesFromUnknown(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ByokMaterialValidationError(`${label} is not bytes`);
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

function normalizeIntKeyedMap(raw: unknown): Map<number, unknown> {
  if (raw instanceof Map) {
    return new Map(
      [...raw.entries()].map(([key, value]) => {
        const numericKey = Number(key);
        if (!Number.isInteger(numericKey)) {
          throw new ByokMaterialValidationError(
            `map key ${String(key)} is not an integer`,
          );
        }
        return [numericKey, value];
      }),
    );
  }
  if (raw && typeof raw === "object") {
    const out = new Map<number, unknown>();
    for (const [key, value] of Object.entries(raw)) {
      const numericKey = Number(key);
      if (!Number.isInteger(numericKey)) {
        throw new ByokMaterialValidationError(
          `map key ${key} is not an integer`,
        );
      }
      out.set(numericKey, value);
    }
    return out;
  }
  throw new ByokMaterialValidationError("delegated COSE_Key is not a map");
}

function parseDelegatedCoseKeyFromPayload(raw: unknown): {
  x: Uint8Array;
  y: Uint8Array;
} {
  if (raw instanceof Uint8Array) {
    throw new ByokMaterialValidationError(
      "payload field 5 must be inline integer-key COSE_Key map, not bstr",
    );
  }
  if (!(raw instanceof Map)) {
    throw new ByokMaterialValidationError(
      "payload field 5 must be CBOR map with integer keys (not string-key object)",
    );
  }
  const m = normalizeIntKeyedMap(raw);
  const kty = Number(m.get(COSE_KTY));
  if (kty !== COSE_KTY_EC2) {
    throw new ByokMaterialValidationError(
      "delegated public key: expected kty EC2",
    );
  }
  const crv = Number(m.get(COSE_CRV));
  if (crv !== COSE_CRV_P256) {
    throw new ByokMaterialValidationError(
      "delegated public key: unsupported crv",
    );
  }
  const x = bytesFromUnknown(m.get(COSE_X), "delegated key x");
  const y = bytesFromUnknown(m.get(COSE_Y), "delegated key y");
  if (x.length !== 32 || y.length !== 32) {
    throw new ByokMaterialValidationError(
      "delegated public key: x and y must be 32 bytes",
    );
  }
  return { x, y };
}

async function importEs256PublicKey(
  x: Uint8Array,
  y: Uint8Array,
): Promise<CryptoKey> {
  const raw = new Uint8Array(65);
  raw[0] = 0x04;
  raw.set(x, 1);
  raw.set(y, 33);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
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
  if (v >= 27) v -= 27;
  const recovery = v;
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

async function verifyKs256DelegationSignature(
  protectedBytes: Uint8Array,
  payloadBytes: Uint8Array,
  signature: Uint8Array,
  rootAddress: Uint8Array,
  rpcUrl?: string,
): Promise<boolean> {
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  const hash = keccak_256(sigStructure);

  if (rpcUrl) {
    try {
      const codeResult = (await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getCode",
          params: [`0x${bytesToHex(rootAddress)}`, "latest"],
        }),
      }).then((r) => r.json())) as { result?: string };
      const code = codeResult.result?.replace(/^0x/i, "") ?? "";
      if (code.length > 0 && !/^0+$/.test(code)) {
        const hashHex = `0x${bytesToHex(hash)}` as `0x${string}`;
        const sigHex = `0x${bytesToHex(signature)}` as `0x${string}`;
        const data = encodeFunctionData({
          abi: ERC1271_ABI,
          functionName: "isValidSignature",
          args: [hashHex, sigHex],
        });
        const callResult = (await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [{ to: `0x${bytesToHex(rootAddress)}`, data }, "latest"],
          }),
        }).then((r) => r.json())) as { result?: string };
        return (
          typeof callResult.result === "string" &&
          callResult.result
            .toLowerCase()
            .startsWith(ERC1271_MAGIC.toLowerCase())
        );
      }
    } catch {
      return false;
    }
  }

  const recovered = recoverSignerAddress(hash, signature);
  return recovered !== null && bytesEqual(recovered, rootAddress);
}

async function verifyDelegationCertificate(
  protectedBytes: Uint8Array,
  payloadBytes: Uint8Array,
  signature: Uint8Array,
  publicRoot: PublicRootMaterial,
  rpcUrl?: string,
): Promise<boolean> {
  if (publicRoot.alg === "ES256") {
    const rootKey = await importEs256PublicKey(publicRoot.x, publicRoot.y);
    const sigStructure = encodeSigStructure(
      protectedBytes,
      new Uint8Array(),
      payloadBytes,
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      rootKey,
      toArrayBuffer(signature),
      toArrayBuffer(sigStructure),
    );
  }
  if (signature.length !== 65 && !rpcUrl) {
    return false;
  }
  return verifyKs256DelegationSignature(
    protectedBytes,
    payloadBytes,
    signature,
    publicRoot.key,
    rpcUrl,
  );
}

export async function validateByokDelegationMaterial(opts: {
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  certificate: Uint8Array;
  publicRoot: PublicRootMaterial;
  ks256RpcUrl?: string;
}): Promise<void> {
  const cert = intKeyDecoder.decode(opts.certificate) as unknown[];
  if (!Array.isArray(cert) || cert.length !== 4) {
    throw new ByokMaterialValidationError(
      "certificate must be COSE_Sign1 array",
    );
  }

  const protectedBytes = bytesFromUnknown(cert[0], "protected");
  const payloadBytes = bytesFromUnknown(cert[2], "payload");
  const signature = bytesFromUnknown(cert[3], "signature");
  if (opts.publicRoot.alg === "ES256" && signature.length !== 64) {
    throw new ByokMaterialValidationError("signature must be 64 bytes");
  }

  const ok = await verifyDelegationCertificate(
    protectedBytes,
    payloadBytes,
    signature,
    opts.publicRoot,
    opts.ks256RpcUrl,
  );
  if (!ok) {
    throw new ByokMaterialValidationError(
      "delegation certificate signature invalid",
    );
  }

  const payloadMap = normalizeIntKeyedMap(intKeyDecoder.decode(payloadBytes));
  const logId = payloadMap.get(PAYLOAD_LOG_ID);
  if (typeof logId !== "string" || logId !== opts.logIdHex32) {
    throw new ByokMaterialValidationError("payload log id mismatch");
  }
  if (Number(payloadMap.get(PAYLOAD_MMR_START)) !== opts.mmrStart) {
    throw new ByokMaterialValidationError("payload mmrStart mismatch");
  }
  if (Number(payloadMap.get(PAYLOAD_MMR_END)) !== opts.mmrEnd) {
    throw new ByokMaterialValidationError("payload mmrEnd mismatch");
  }

  const { x, y } = parseDelegatedCoseKeyFromPayload(
    payloadMap.get(PAYLOAD_DELEGATED_KEY),
  );
  const submitted = parseDelegatedCoseKeyFromPayload(
    intKeyDecoder.decode(opts.delegatedPublicKey),
  );
  if (!bytesEqual(x, submitted.x) || !bytesEqual(y, submitted.y)) {
    throw new ByokMaterialValidationError(
      "delegatedPublicKey does not match certificate payload",
    );
  }
}

export { COSE_ALG_KS256 };
