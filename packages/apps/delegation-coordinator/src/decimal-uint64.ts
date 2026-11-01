/**
 * Canonical decimal-string codec for uint64 values on the coordinator's JSON
 * routes and webhook events: every delegation MMR range bound (`mmrStart`,
 * `mmrEnd`) is a decimal string `^(0|[1-9][0-9]*)$`, ≤ 2^64-1, and a JSON
 * number is a 400. The contract and its one implementation live in
 * `@forestrie/delegation-cose` (`decimal-uint64.ts`), shared with the e2e kit
 * and the webhook receivers; this module re-exports it so coordinator code
 * keeps a local import path.
 */

export {
  DecimalUint64Error,
  formatDecimalUint64,
  parseDecimalUint64,
} from "@forestrie/delegation-cose";
