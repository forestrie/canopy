export class KmsError extends Error {
  readonly status: number;
  readonly responseText?: string;

  constructor(message: string, status: number, responseText?: string) {
    super(message);
    this.name = "KmsError";
    this.status = status;
    this.responseText = responseText;
  }
}

export interface KmsKeyVersionRef {
  projectId: string;
  location: string;
  keyRing: string;
  cryptoKey: string;
  cryptoKeyVersion: string;
}

const publicKeyDerCache = new Map<string, Uint8Array>();

function keyVersionResourceName(ref: KmsKeyVersionRef): string {
  // projects/*/locations/*/keyRings/*/cryptoKeys/*/cryptoKeyVersions/*
  return `projects/${ref.projectId}/locations/${ref.location}/keyRings/${ref.keyRing}/cryptoKeys/${ref.cryptoKey}/cryptoKeyVersions/${ref.cryptoKeyVersion}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Safe for small buffers (digests, signatures). Prefer streaming if you ever
  // encode large payloads.
  return btoa(String.fromCharCode(...bytes));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return base64ToBytes(base64);
}

export async function kmsAsymmetricSignSha256(
  accessToken: string,
  ref: KmsKeyVersionRef,
  digestSha256: Uint8Array,
): Promise<Uint8Array> {
  const name = keyVersionResourceName(ref);
  const url = `https://cloudkms.googleapis.com/v1/${name}:asymmetricSign`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      digest: { sha256: bytesToBase64(digestSha256) },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => undefined);
    throw new KmsError(
      `KMS asymmetricSign failed (${resp.status})`,
      resp.status,
      text,
    );
  }

  const json = (await resp.json()) as { signature?: string };
  if (!json.signature) {
    throw new KmsError("KMS asymmetricSign missing signature", 502);
  }

  return base64ToBytes(json.signature);
}

export async function kmsGetPublicKeyDer(
  accessToken: string,
  ref: KmsKeyVersionRef,
): Promise<Uint8Array> {
  const name = keyVersionResourceName(ref);
  const cached = publicKeyDerCache.get(name);
  if (cached) return cached;

  // REST surface uses a `publicKey` subresource on the cryptoKeyVersion.
  const url = `https://cloudkms.googleapis.com/v1/${name}/publicKey`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => undefined);
    throw new KmsError(
      `KMS getPublicKey failed (${resp.status})`,
      resp.status,
      text,
    );
  }

  const json = (await resp.json()) as { pem?: string };
  if (!json.pem) {
    throw new KmsError("KMS getPublicKey missing pem", 502);
  }

  const der = pemToDer(json.pem);
  publicKeyDerCache.set(name, der);
  return der;
}
