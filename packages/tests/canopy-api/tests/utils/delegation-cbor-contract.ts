/**
 * Go delegationcert-compatible checks — re-exported from @canopy/delegation-cose.
 */

export {
  assertDelegatedKeyInCertificate as assertGoCompatibleDelegatedKeyInCertificate,
  normalizeIntKeyedMap,
  parseDelegatedCoseKeyFromPayload,
  PAYLOAD_DELEGATED_KEY,
} from "@canopy/delegation-cose";
