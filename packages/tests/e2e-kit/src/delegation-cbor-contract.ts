/**
 * Go delegationcert-compatible checks — re-exported from @forestrie/delegation-cose.
 */

export {
  assertDelegatedKeyInCertificate as assertGoCompatibleDelegatedKeyInCertificate,
  normalizeIntKeyedMap,
  parseDelegatedCoseKeyFromPayload,
  PAYLOAD_DELEGATED_KEY,
} from "@forestrie/delegation-cose";
