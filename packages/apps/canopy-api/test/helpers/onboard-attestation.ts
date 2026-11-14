/**
 * Valid bootstrap-key attestations for onboard-request tests (ADR-0059
 * decision 8). Every POST /api/onboarding/requests must carry one, so tests
 * stub the chain RPC with `bootstrapConfigResultHex()` (which reports this
 * module's fixed ES256 key) and add key 7 with `withAttestation`.
 */
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import {
  encodeCborDeterministic,
  encodeSigStructure,
} from "@forestrie/encoding";
import {
  CLAIM_CHAIN_BINDING,
  ONBOARD_ATTESTATION_CONTENT_TYPE,
} from "../../src/onboarding/onboard-attestation.js";
import { COSE_ALG_ES256 } from "../../src/onboarding/univocity-identity-probe.js";

/** Origin the onboard tests post to; the handler always accepts it as aud. */
export const ONBOARD_TEST_ORIGIN = "http://localhost";

const TEST_BOOTSTRAP_PRIV = new Uint8Array(32).fill(7);
const TEST_BOOTSTRAP_PUB_XY = p256
  .getPublicKey(TEST_BOOTSTRAP_PRIV, false)
  .slice(1);

/** CBOR int keys of the onboard request body the attestation binds to. */
const FIELD_CHAIN_ID = 2;
const FIELD_UNIVOCITY_ADDR = 3;
const FIELD_ATTESTATION = 7;

/**
 * Every attestation is single-use, so each one must differ in its signed
 * bytes even within one clock second: the counter backdates `iat` by one
 * more second per call, staying far inside the verifier's window.
 */
let attestationCounter = 0;

/**
 * Return `fields` plus a fresh attestation (key 7) over the binding in keys
 * 2 and 3, signed by the fixture bootstrap key.
 */
export function withAttestation(
  fields: Record<number, unknown>,
): Record<number, unknown> {
  const chainId = String(fields[FIELD_CHAIN_ID]);
  const univocityAddr = String(fields[FIELD_UNIVOCITY_ADDR]);
  return {
    ...fields,
    [FIELD_ATTESTATION]: signAttestation(chainId, univocityAddr),
  };
}

/** bootstrapConfig() eth_call result carrying the fixture ES256 key. */
export function bootstrapConfigResultHex(): string {
  const alg =
    "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff9"; // -7
  const offset =
    "0000000000000000000000000000000000000000000000000000000000000040";
  const len =
    "0000000000000000000000000000000000000000000000000000000000000040";
  const key = Array.from(TEST_BOOTSTRAP_PUB_XY)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${alg}${offset}${len}${key}`;
}

function signAttestation(chainId: string, univocityAddr: string): Uint8Array {
  const now = Math.floor(Date.now() / 1000);
  const iat = now - 60 - attestationCounter++;
  const protectedBytes = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, COSE_ALG_ES256],
      [3, ONBOARD_ATTESTATION_CONTENT_TYPE],
    ]),
  );
  const payloadBytes = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, `eip155:${chainId}:0x${univocityAddr}`],
      [3, ONBOARD_TEST_ORIGIN],
      [4, now + 3600],
      [6, iat],
      [
        CLAIM_CHAIN_BINDING,
        new Map<number, unknown>([
          [1, chainId],
          [2, univocityAddr],
        ]),
      ],
    ]),
  );
  const sigStructure = encodeSigStructure(
    protectedBytes,
    new Uint8Array(0),
    payloadBytes,
  );
  const signature = p256
    .sign(sha256(sigStructure), TEST_BOOTSTRAP_PRIV, { prehash: false })
    .toCompactRawBytes();
  return encodeCborDeterministic([
    protectedBytes,
    new Map(),
    payloadBytes,
    signature,
  ]);
}
