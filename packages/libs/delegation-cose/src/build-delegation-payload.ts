/**
 * Delegation certificate payload and Sig_structure construction. Payload int-key
 * labels and field-5 inline COSE_Key rules match arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert)
 * so sealer and delegation-coordinator parse the same bytes.
 */

import { encodeSigStructure } from "./encode-sig-structure.js";
import type { DelegationInput } from "./delegation-input.js";
import type { DelegationToBeSigned } from "./delegation-tbs.js";
import { decodeDelegatedCoseKeyFromBytes } from "./parse-delegated-cose-key.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
import { UINT64_MAX } from "./to-uint64.js";
import {
  PAYLOAD_CONSTRAINTS,
  PAYLOAD_DELEGATION_ID,
  PAYLOAD_DELEGATED_KEY,
  PAYLOAD_EXPIRES_AT,
  PAYLOAD_ISSUED_AT,
  PAYLOAD_LOG_ID,
  PAYLOAD_MMR_END,
  PAYLOAD_MMR_START,
  PAYLOAD_SCHEMA_VER,
} from "./payload-labels.js";

/**
 * Validate the MMR range against the uint64 wire contract arbor's sealer
 * decodes (Go `uint64`) before it is signed: both bounds in `[0, 2^64-1]`
 * and `mmrStart <= mmrEnd`. A certificate the sealer would reject is never
 * produced (FOR-613).
 *
 * @param input - Reads `mmrStart` and `mmrEnd` only.
 * @throws When a bound is outside uint64 or `mmrStart > mmrEnd`.
 */
function assertMmrRange(input: DelegationInput): void {
  for (const [name, v] of [
    ["mmrStart", input.mmrStart],
    ["mmrEnd", input.mmrEnd],
  ] as const) {
    if (typeof v !== "bigint" || v < 0n || v > UINT64_MAX) {
      throw new Error(`delegation ${name} ${String(v)} is outside uint64`);
    }
  }
  if (input.mmrStart > input.mmrEnd) {
    throw new Error(
      `delegation mmrStart ${input.mmrStart} > mmrEnd ${input.mmrEnd}`,
    );
  }
}

/**
 * Resolve issuance and expiry timestamps from optional {@link DelegationInput}
 * fields, applying default TTL when neither bound is supplied.
 *
 * @param input - Delegation parameters; reads `issuedAt`, `expiresAt`, and
 *   `ttlSeconds` only.
 */
function resolveTimestamps(input: DelegationInput): {
  issuedAt: number;
  expiresAt: number;
} {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 3600;
  const expiresAt = input.expiresAt ?? issuedAt + ttl;
  return { issuedAt, expiresAt };
}

/**
 * Resolve or generate the 16-byte delegation correlation id carried in
 * payload label 10.
 *
 * @param input - Reads `delegationId` when present; otherwise generates random
 *   bytes.
 */
function resolveDelegationId(input: DelegationInput): Uint8Array {
  if (input.delegationId) {
    if (input.delegationId.length !== 16) {
      throw new Error("delegationId must be 16 bytes");
    }
    return input.delegationId;
  }
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * CBOR-encode the integer-key delegation payload map (log id, MMR bounds,
 * delegated key, validity window). Field 5 embeds the delegated EC2 P-256
 * COSE_Key inline — never as a nested bstr.
 *
 * @param input - Full delegation parameters including
 *   `delegatedPublicKeyCbor`.
 * @returns Payload bstr bytes for COSE Sign1 and Sig_structure.
 * @throws When the MMR range is outside uint64 or `mmrStart > mmrEnd`.
 */
export function buildDelegationPayloadBytes(
  input: DelegationInput,
): Uint8Array {
  assertMmrRange(input);
  const { issuedAt, expiresAt } = resolveTimestamps(input);
  const delegatedKey = decodeDelegatedCoseKeyFromBytes(
    input.delegatedPublicKeyCbor,
  );
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [PAYLOAD_LOG_ID, input.logIdHex32],
      [PAYLOAD_MMR_START, input.mmrStart],
      [PAYLOAD_MMR_END, input.mmrEnd],
      [PAYLOAD_DELEGATED_KEY, delegatedKey],
      [PAYLOAD_CONSTRAINTS, input.constraints ?? {}],
      [PAYLOAD_SCHEMA_VER, 1],
      [PAYLOAD_ISSUED_AT, issuedAt],
      [PAYLOAD_EXPIRES_AT, expiresAt],
      [PAYLOAD_DELEGATION_ID, resolveDelegationId(input)],
    ]),
  );
}

/**
 * Combine protected header and payload into a {@link DelegationToBeSigned}
 * ready for root signing over `sigStructureBytes`.
 *
 * @param protectedBytes - CBOR bstr of the COSE protected header map.
 * @param payloadBytes - CBOR bstr from {@link buildDelegationPayloadBytes}.
 */
export function buildDelegationToBeSigned(
  protectedBytes: Uint8Array,
  payloadBytes: Uint8Array,
): DelegationToBeSigned {
  const sigStructureBytes = encodeSigStructure(
    protectedBytes,
    new Uint8Array(),
    payloadBytes,
  );
  return { protectedBytes, payloadBytes, sigStructureBytes };
}
