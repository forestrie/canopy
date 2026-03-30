/**
 * Custodian HTTP client for Plan 0016: raw ECDSA over a digest (no custodian COSE wrapper).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

import type { DelegationCurve } from "./cose/sign1";

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function pemToDerFromPublicKeyPem(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(base64);
}

export function algMatchesDelegatedCurve(
  custodianAlg: string,
  curve: DelegationCurve,
): boolean {
  const a = custodianAlg.trim().toUpperCase();
  if (curve === "secp256r1") return a === "ES256";
  if (curve === "secp256k1") return a === "KS256";
  return false;
}

export async function fetchCustodianPublicKeyMeta(
  custodianBaseUrl: string,
  keyId: string,
): Promise<{ publicKeyPem: string; alg: string }> {
  const base = trimBase(custodianBaseUrl);
  const enc = encodeURIComponent(keyId);
  const res = await fetch(`${base}/api/keys/${enc}/public`, {
    headers: { Accept: "application/cbor" },
  });
  if (!res.ok) {
    throw new Error(`custodian public key: ${res.status} ${await res.text()}`);
  }
  const raw = decodeCbor(new Uint8Array(await res.arrayBuffer())) as unknown;
  let publicKeyPem = "";
  let alg = "ES256";
  if (raw instanceof Map) {
    publicKeyPem = String(raw.get("publicKey") ?? "");
    alg = String(raw.get("alg") ?? "ES256");
  } else if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    publicKeyPem = String(o.publicKey ?? "");
    alg = String(o.alg ?? "ES256");
  }
  if (!publicKeyPem.trim()) {
    throw new Error("custodian public key response missing publicKey");
  }
  return { publicKeyPem, alg };
}

/**
 * POST /api/keys/{keyId}/sign with rawSignatureOnly — returns 64-byte IEEE P1363 signature.
 */
export async function postCustodianSignRaw(
  custodianBaseUrl: string,
  keyId: string,
  bearerToken: string,
  digestSha256: Uint8Array,
): Promise<Uint8Array> {
  if (digestSha256.byteLength !== 32) {
    throw new Error("digest must be 32 bytes");
  }
  const base = trimBase(custodianBaseUrl);
  const enc = encodeURIComponent(keyId);
  const packed = encodeCbor({
    payloadHash: digestSha256,
    rawSignatureOnly: true,
  });
  // Copy CBOR bytes into a fresh `Uint8Array` so `Blob` / `fetch` match DOM
  // typings (reject generic `Uint8Array<ArrayBufferLike>` and `SharedArrayBuffer`).
  const packedBytes =
    packed instanceof ArrayBuffer
      ? new Uint8Array(packed)
      : new Uint8Array(
          (packed as ArrayBufferView).buffer,
          (packed as ArrayBufferView).byteOffset,
          (packed as ArrayBufferView).byteLength,
        );
  const bodyCopy = new Uint8Array(packedBytes.byteLength);
  bodyCopy.set(packedBytes);
  const body = new Blob([bodyCopy], { type: "application/cbor" });
  const res = await fetch(`${base}/api/keys/${enc}/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`custodian sign-raw: ${res.status} ${await res.text()}`);
  }
  const out = decodeCbor(new Uint8Array(await res.arrayBuffer())) as unknown;
  let sig: Uint8Array | undefined;
  if (out instanceof Map) {
    sig = out.get("signature") as Uint8Array | undefined;
  } else if (out && typeof out === "object" && "signature" in out) {
    sig = (out as { signature: Uint8Array }).signature;
  }
  if (!(sig instanceof Uint8Array) || sig.length !== 64) {
    throw new Error("custodian sign-raw: expected 64-byte signature");
  }
  return sig;
}
