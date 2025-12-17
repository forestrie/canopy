import { encodeToCbor } from "../cbor/codec";
import { derEcdsaToRawRs } from "./der";
import { sha256 } from "./kid";

export type DelegationCurve = "secp256k1" | "secp256r1";

export const COSE_ALG = {
  secp256k1: -47, // ES256K
  secp256r1: -7, // ES256
} as const;

export interface DelegatedCoseKey {
  kty: 2; // EC2
  crv: 8 | 1; // secp256k1=8, P-256=1
  x: Uint8Array; // 32 bytes
  y: Uint8Array; // 32 bytes
}

export interface DelegationPayloadInput {
  logId?: string;
  mmrStart?: bigint;
  mmrEnd?: bigint;
  delegatedKey: DelegatedCoseKey;
  constraints: unknown; // canonicalized upstream
  delegationId: Uint8Array; // 16–32 bytes recommended
  issuedAt?: bigint;
  expiresAt?: bigint;
}

export interface DelegationToBeSigned {
  protectedBytes: Uint8Array;
  payloadBytes: Uint8Array;
  sigStructureBytes: Uint8Array;
  digestSha256: Uint8Array;
}

function delegatedKeyToCoseMap(key: DelegatedCoseKey): Map<number, unknown> {
  // Canonical key ordering for the integer labels:
  // 1 (0x01), then -1 (0x20), -2 (0x21), -3 (0x22).
  return new Map<number, unknown>([
    [1, 2], // kty = EC2
    [-1, key.crv],
    [-2, key.x],
    [-3, key.y],
  ]);
}

export async function buildDelegationToBeSigned(
  curve: DelegationCurve,
  kid: Uint8Array,
  input: DelegationPayloadInput,
): Promise<DelegationToBeSigned> {
  const alg = COSE_ALG[curve];

  const protectedMap = new Map<number, unknown>([
    [1, alg],
    [3, "application/forestrie.delegation+cbor"],
    [4, kid],
  ]);
  const protectedBytes = encodeToCbor(protectedMap);

  // Deterministic payload map with integer keys (see profile doc).
  const payloadMap = new Map<number, unknown>();
  if (input.logId !== undefined) payloadMap.set(1, input.logId);
  if (input.mmrStart !== undefined) payloadMap.set(3, input.mmrStart);
  if (input.mmrEnd !== undefined) payloadMap.set(4, input.mmrEnd);
  payloadMap.set(5, delegatedKeyToCoseMap(input.delegatedKey));
  payloadMap.set(6, input.constraints);
  payloadMap.set(7, 1); // schema_version
  if (input.issuedAt !== undefined) payloadMap.set(8, input.issuedAt);
  if (input.expiresAt !== undefined) payloadMap.set(9, input.expiresAt);
  payloadMap.set(10, input.delegationId);

  const payloadBytes = encodeToCbor(payloadMap);

  // COSE_Sign1 signature input (Sig_structure):
  // ["Signature1", protected, external_aad, payload]
  const sigStructureBytes = encodeToCbor([
    "Signature1",
    protectedBytes,
    new Uint8Array(0),
    payloadBytes,
  ]);

  const digestSha256 = await sha256(sigStructureBytes);

  return { protectedBytes, payloadBytes, sigStructureBytes, digestSha256 };
}

export function assembleCoseSign1(
  protectedBytes: Uint8Array,
  payloadBytes: Uint8Array,
  signatureRaw: Uint8Array,
): Uint8Array {
  // COSE_Sign1 = [ protected: bstr, unprotected: map, payload: bstr, signature: bstr ]
  return encodeToCbor([protectedBytes, new Map(), payloadBytes, signatureRaw]);
}

export function kmsDerSignatureToCoseRaw(der: Uint8Array): Uint8Array {
  return derEcdsaToRawRs(der, 32);
}


