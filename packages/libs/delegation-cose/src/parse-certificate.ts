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

/**
 * Parse delegation scope and validity metadata from a COSE_Sign1 certificate.
 *
 * @param certificate - Full delegation certificate bytes.
 * @returns Structured payload fields for coordinator persistence or sealer
 *   lease checks.
 * @throws When required payload labels are missing or malformed.
 */
export function parseDelegationCertificate(
  certificate: Uint8Array,
): CertificateInfo {
  const { payloadBytes } = decodeCoseSign1Parts(certificate);
  const payloadMap = normalizeIntKeyedMap(decodeCborDeterministic(payloadBytes));
  const logIdHex32 = payloadMap.get(PAYLOAD_LOG_ID);
  if (typeof logIdHex32 !== "string") {
    throw new Error("payload missing log id");
  }
  return {
    logIdHex32,
    mmrStart: Number(payloadMap.get(PAYLOAD_MMR_START)),
    mmrEnd: Number(payloadMap.get(PAYLOAD_MMR_END)),
    issuedAt: Number(payloadMap.get(PAYLOAD_ISSUED_AT)),
    expiresAt: Number(payloadMap.get(PAYLOAD_EXPIRES_AT)),
    schemaVersion: Number(payloadMap.get(PAYLOAD_SCHEMA_VER)),
    delegationId: bytesFromUnknown(
      payloadMap.get(PAYLOAD_DELEGATION_ID),
      "delegationId",
    ),
  };
}
