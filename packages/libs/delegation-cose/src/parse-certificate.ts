/**
 * Delegation certificate payload parsing (post-verification). Extracts log
 * scope and validity fields from the COSE payload map; does not verify the
 * root signature — use {@link verifyDelegationCertificateEs256} or
 * {@link verifyDelegationCertificateKs256} first.
 */

import { decodeCborDeterministic } from "@forestrie/encoding";
import type { CertificateInfo } from "./certificate-info.js";
import { bytesFromUnknown } from "./bytes-utils.js";
import {
  decodeCoseSign1Parts,
  normalizeIntKeyedMap,
} from "./parse-delegated-cose-key.js";
import {
  PAYLOAD_DELEGATION_ID,
  PAYLOAD_EXPIRES_AT,
  PAYLOAD_ISSUED_AT,
  PAYLOAD_LOG_ID,
  PAYLOAD_MMR_END,
  PAYLOAD_MMR_START,
  PAYLOAD_SCHEMA_VER,
} from "./payload-labels.js";
import { readUint64Label } from "./read-uint64-label.js";
import { toSafeUint } from "./to-safe-uint.js";

/**
 * Parse delegation scope and validity metadata from a COSE_Sign1 certificate.
 *
 * @param certificate - Full delegation certificate bytes.
 * @returns Structured payload fields for coordinator persistence or sealer
 *   lease checks.
 * @throws When required payload labels are missing or malformed: an MMR
 *   range label that is not a uint64, `mmrStart > mmrEnd`, or a schema
 *   version / validity label (7/8/9) that is not a non-negative safe
 *   integer.
 */
export function parseDelegationCertificate(
  certificate: Uint8Array,
): CertificateInfo {
  const { payloadBytes } = decodeCoseSign1Parts(certificate);
  const payloadMap = normalizeIntKeyedMap(
    decodeCborDeterministic(payloadBytes),
  );
  const logIdHex32 = payloadMap.get(PAYLOAD_LOG_ID);
  if (typeof logIdHex32 !== "string") {
    throw new Error("payload missing log id");
  }
  // The range is uint64 (CBOR major type 0) and kept as bigint: Number()
  // would round above 2^53 and accept a cbor-x float.
  const mmrStart = readUint64Label(payloadMap, PAYLOAD_MMR_START, "mmrStart");
  const mmrEnd = readUint64Label(payloadMap, PAYLOAD_MMR_END, "mmrEnd");
  if (mmrStart > mmrEnd) {
    throw new Error(`payload mmrStart ${mmrStart} > mmrEnd ${mmrEnd}`);
  }
  return {
    logIdHex32,
    mmrStart,
    mmrEnd,
    issuedAt: readSafeUintLabel(payloadMap, PAYLOAD_ISSUED_AT, "issuedAt"),
    expiresAt: readSafeUintLabel(payloadMap, PAYLOAD_EXPIRES_AT, "expiresAt"),
    schemaVersion: readSafeUintLabel(
      payloadMap,
      PAYLOAD_SCHEMA_VER,
      "schemaVersion",
    ),
    delegationId: bytesFromUnknown(
      payloadMap.get(PAYLOAD_DELEGATION_ID),
      "delegationId",
    ),
  };
}

/**
 * Read a required label as a non-negative safe integer: never `Number()`,
 * which turns a missing label or a text value into `NaN`.
 *
 * @throws When the label is missing or not a non-negative safe integer.
 */
function readSafeUintLabel(
  payloadMap: ReadonlyMap<number, unknown>,
  label: number,
  name: string,
): number {
  if (!payloadMap.has(label)) {
    throw new Error(`payload missing ${name} (label ${label})`);
  }
  return toSafeUint(payloadMap.get(label), `${name} (label ${label})`);
}
