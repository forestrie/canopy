import { encodeSigStructure } from "@canopy/encoding";
import type { DelegationInput } from "./delegation-input.js";
import type { DelegationToBeSigned } from "./delegation-tbs.js";
import { decodeDelegatedCoseKeyFromBytes } from "./parse-delegated-cose-key.js";
import { encodeIntKeyCbor } from "./encode-int-map.js";
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

function resolveTimestamps(input: DelegationInput): {
  issuedAt: number;
  expiresAt: number;
} {
  const issuedAt = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 3600;
  const expiresAt = input.expiresAt ?? issuedAt + ttl;
  return { issuedAt, expiresAt };
}

function resolveDelegationId(input: DelegationInput): Uint8Array {
  if (input.delegationId) {
    if (input.delegationId.length !== 16) {
      throw new Error("delegationId must be 16 bytes");
    }
    return input.delegationId;
  }
  return crypto.getRandomValues(new Uint8Array(16));
}

export function buildDelegationPayloadBytes(
  input: DelegationInput,
): Uint8Array {
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
