/**
 * Validates runner-submitted BYOK delegation material before persistence.
 * Mirrors arbor delegationcert rules for payload field 5 (integer-key COSE_Key).
 */

import { Decoder } from "cbor-x";
import {
  COSE_ALG_KS256,
  decodeCoseSign1Parts,
  decodeDelegatedCoseKeyFromBytes,
  normalizeIntKeyedMap,
  parseDelegatedCoseKeyFromPayload,
  parseDelegationCertificate,
  verifyDelegationCertificateEs256,
  verifyDelegationCertificateKs256,
} from "@canopy/delegation-cose";
import { createKs256RpcVerifyHooks } from "./ks256-rpc-verify-hooks.js";

const PAYLOAD_DELEGATED_KEY = 5;

const intKeyDecoder = new Decoder({ mapsAsObjects: false });

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function wrapValidationError(err: unknown): never {
  if (err instanceof ByokMaterialValidationError) {
    throw err;
  }
  throw new ByokMaterialValidationError(
    err instanceof Error ? err.message : String(err),
  );
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

export async function validateByokDelegationMaterial(opts: {
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  certificate: Uint8Array;
  publicRoot: PublicRootMaterial;
  ks256RpcUrl?: string;
}): Promise<void> {
  const { signature } = decodeCoseSign1Parts(opts.certificate);
  if (opts.publicRoot.alg === "ES256" && signature.length !== 64) {
    throw new ByokMaterialValidationError("signature must be 64 bytes");
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
    throw new ByokMaterialValidationError(
      "delegation certificate signature invalid",
    );
  }

  const info = parseDelegationCertificate(opts.certificate);
  if (info.logIdHex32 !== opts.logIdHex32) {
    throw new ByokMaterialValidationError("payload log id mismatch");
  }
  if (info.mmrStart !== opts.mmrStart) {
    throw new ByokMaterialValidationError("payload mmrStart mismatch");
  }
  if (info.mmrEnd !== opts.mmrEnd) {
    throw new ByokMaterialValidationError("payload mmrEnd mismatch");
  }

  const { payloadBytes } = decodeCoseSign1Parts(opts.certificate);
  let x: Uint8Array;
  let y: Uint8Array;
  let submitted: { x: Uint8Array; y: Uint8Array };
  try {
    const payloadMap = normalizeIntKeyedMap(intKeyDecoder.decode(payloadBytes));
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
    throw new ByokMaterialValidationError(
      "delegatedPublicKey does not match certificate payload",
    );
  }
}

export { COSE_ALG_KS256 };
