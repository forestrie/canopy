import {
  decodeCborDeterministic,
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";

function cborBytes(value: unknown): Uint8Array {
  return encodeCborDeterministic(value);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function generateTestRootKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

export async function buildTestByokMaterial(opts: {
  rootKeyPair: CryptoKeyPair;
  logIdHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  /** Override the signed issuedAt/expiresAt (defaults to a fixed 2023 pair). */
  issuedAt?: number;
  expiresAt?: number;
}): Promise<{
  certificate: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  x: Uint8Array;
  y: Uint8Array;
}> {
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey(
      "raw",
      opts.rootKeyPair.publicKey,
    )) as ArrayBuffer,
  );
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  const kid = new Uint8Array(await crypto.subtle.digest("SHA-256", raw)).slice(
    0,
    16,
  );
  const delegated = decodeDelegatedKey(opts.delegatedPublicKey);
  const issuedAt = opts.issuedAt ?? 1_700_000_000;
  // Default to a far-future expiry so issue-time coverage retrieval
  // (expires_at > now, FOR-390) returns the cert; tests needing a specific
  // window pass issuedAt/expiresAt explicitly.
  const expiresAt = opts.expiresAt ?? 4_102_444_800; // 2100-01-01
  const protectedBytes = cborBytes(
    new Map<number, unknown>([
      [1, -7],
      [3, "application/forestrie.delegation+cbor"],
      [4, kid],
    ]),
  );
  const payloadBytes = cborBytes(
    new Map<number, unknown>([
      [1, opts.logIdHex32],
      [3, opts.mmrStart],
      [4, opts.mmrEnd],
      [5, delegated],
      [6, new Map<number, unknown>()],
      [7, 1],
      [8, issuedAt],
      [9, expiresAt],
      [10, new Uint8Array(16)],
    ]),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      opts.rootKeyPair.privateKey,
      toArrayBuffer(
        encodeSigStructure(protectedBytes, new Uint8Array(), payloadBytes),
      ),
    ),
  );
  return {
    certificate: cborBytes([
      protectedBytes,
      new Map<number, unknown>(),
      payloadBytes,
      signature,
    ]),
    issuedAt,
    expiresAt,
    x,
    y,
  };
}

function decodeDelegatedKey(bytes: Uint8Array): Map<number, unknown> {
  const raw = decodeCborDeterministic(bytes);
  if (raw instanceof Map) {
    return new Map([...raw.entries()].map(([k, v]) => [Number(k), v] as const));
  }
  if (raw && typeof raw === "object" && !ArrayBuffer.isView(raw)) {
    const out = new Map<number, unknown>();
    for (const [k, v] of Object.entries(raw)) {
      out.set(Number(k), v);
    }
    return out;
  }
  throw new Error("delegated key must be a map");
}

/** Valid EC2 COSE_Key bytes for coordinator unit tests. */
export function testDelegatedCoseKey(seed: number): Uint8Array {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = (seed + i) & 0xff;
    y[i] = (seed + 100 + i) & 0xff;
  }
  return cborBytes(
    new Map<number, unknown>([
      [1, 2],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}
