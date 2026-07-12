/**
 * Validates runner-submitted BYOK delegation certificates before persistence.
 *
 * Mirrors [arbor sealer](https://github.com/forestrie/arbor/blob/main/services/sealer/)
 * delegationcert rules for payload field 5 (integer-key COSE_Key). KS256 paths
 * use ERC-1271 via {@link createKs256RpcVerifyHooks} per
 * [univocity docs/arc](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 */

import { decodeCborDeterministic } from "@forestrie/encoding";
import {
  COSE_ALG_KS256,
  decodeCoseSign1Parts,
  decodeDelegatedCoseKeyFromBytes,
  normalizeIntKeyedMap,
  parseDelegatedCoseKeyFromPayload,
  parseDelegationCertificate,
  verifyDelegationCertificateEs256,
  verifyDelegationCertificateKs256,
} from "@forestrie/delegation-cose";
import { createKs256RpcVerifyHooks } from "./ks256-rpc-verify-hooks.js";

/** COSE payload map key for embedded delegated COSE_Key. */
const PAYLOAD_DELEGATED_KEY = 5;

/** ES256 public root coordinates for certificate verify. */
export interface PublicRootEs256 {
  alg: "ES256";
  x: Uint8Array;
  y: Uint8Array;
}

/** KS256 contract-address root for ERC-1271 certificate verify. */
export interface PublicRootKs256 {
  alg: "KS256";
  key: Uint8Array;
}

/** Registered public root material (ES256 or KS256). */
export type PublicRootMaterial = PublicRootEs256 | PublicRootKs256;

/** @deprecated use PublicRootMaterial */
export type PublicRootXY = PublicRootEs256;

/** Thrown when certificate bytes fail structural or crypto validation. */
export class ByokCertificateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByokCertificateValidationError";
  }
}

/** @deprecated use ByokCertificateValidationError */
export const ByokMaterialValidationError = ByokCertificateValidationError;

/** Copy Uint8Array to ArrayBuffer for WebCrypto import. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/** Constant-time byte equality. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Normalize unknown errors into {@link ByokCertificateValidationError}. */
function wrapValidationError(err: unknown): never {
  if (err instanceof ByokCertificateValidationError) {
    throw err;
  }
  throw new ByokCertificateValidationError(
    err instanceof Error ? err.message : String(err),
  );
}

/** Import uncompressed P-256 public key for ES256 verify. */
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

/**
 * Validate BYOK delegation certificate before DO persistence.
 *
 * @param opts.logIdHex32 - Target log id.
 * @param opts.mmrStart - Expected MMR range start in payload.
 * @param opts.mmrEnd - Expected MMR range end in payload.
 * @param opts.delegatedPublicKey - Submitted delegated key CBOR bytes.
 * @param opts.certificate - COSE Sign1 certificate bytes.
 * @param opts.issuedAt - Submit-body issuedAt; must match COSE payload field 8.
 * @param opts.expiresAt - Submit-body expiresAt; must match COSE payload field 9.
 * @param opts.publicRoot - Stored log public root for verify.
 * @param opts.ks256RpcUrl - Optional JSON-RPC for KS256 ERC-1271.
 * @throws {@link ByokCertificateValidationError} when validation fails.
 */
export async function validateByokDelegationCertificate(opts: {
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  publicRoot: PublicRootMaterial;
  ks256RpcUrl?: string;
}): Promise<void> {
  const info = parseDelegationCertificate(opts.certificate);
  if (info.logIdHex32 !== opts.logIdHex32) {
    throw new ByokCertificateValidationError("payload log id mismatch");
  }
  if (info.mmrStart !== opts.mmrStart) {
    throw new ByokCertificateValidationError("payload mmrStart mismatch");
  }
  if (info.mmrEnd !== opts.mmrEnd) {
    throw new ByokCertificateValidationError("payload mmrEnd mismatch");
  }
  if (opts.issuedAt !== info.issuedAt) {
    throw new ByokCertificateValidationError(
      "submit issuedAt does not match certificate payload",
    );
  }
  if (opts.expiresAt !== info.expiresAt) {
    throw new ByokCertificateValidationError(
      "submit expiresAt does not match certificate payload",
    );
  }

  const { payloadBytes } = decodeCoseSign1Parts(opts.certificate);
  let x: Uint8Array;
  let y: Uint8Array;
  let submitted: { x: Uint8Array; y: Uint8Array };
  try {
    const payloadMap = normalizeIntKeyedMap(
      decodeCborDeterministic(payloadBytes),
    );
    ({ x, y } = parseDelegatedCoseKeyFromPayload(
      payloadMap.get(PAYLOAD_DELEGATED_KEY),
    ));
    submitted = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(opts.delegatedPublicKey),
    );
  } catch (err) {
    wrapValidationError(err);
  }
  if (!bytesEqual(x, submitted.x) || !bytesEqual(y, submitted.y)) {
    throw new ByokCertificateValidationError(
      "delegatedPublicKey does not match certificate payload",
    );
  }

  const { signature } = decodeCoseSign1Parts(opts.certificate);
  if (opts.publicRoot.alg === "ES256" && signature.length !== 64) {
    throw new ByokCertificateValidationError("signature must be 64 bytes");
  }

  let ok = false;
  if (opts.publicRoot.alg === "ES256") {
    const rootKey = await importEs256PublicKey(
      opts.publicRoot.x,
      opts.publicRoot.y,
    );
    ok = await verifyDelegationCertificateEs256(opts.certificate, rootKey);
  } else {
    const hooks = opts.ks256RpcUrl
      ? createKs256RpcVerifyHooks(opts.ks256RpcUrl)
      : undefined;
    ok = await verifyDelegationCertificateKs256(
      opts.certificate,
      opts.publicRoot.key,
      hooks,
    );
  }
  if (!ok) {
    throw new ByokCertificateValidationError(
      "delegation certificate signature invalid",
    );
  }
}

/** @deprecated use validateByokDelegationCertificate */
export const validateByokDelegationMaterial = validateByokDelegationCertificate;

export { COSE_ALG_KS256 };
