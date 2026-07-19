export type {
  ReceiptVerifyResult,
  ReceiptVerifyStage,
} from "./receipt-verify-result.js";
/** Canonical grant wire type — owned by @forestrie/encoding (FOR-353, ADR-0048). */
export type { Grant } from "@forestrie/encoding";
export type { VerifyGrantReceiptOfflineInput } from "./verify-grant-receipt-offline.js";
export type { VerifyReceiptOfflineInput } from "./verify-grant-receipt-offline.js";
export { parseReceipt } from "./parse-receipt.js";
export type {
  BuildReceiptOfflineInput,
  ComputedAccumulatorPeak,
  MassifNodeStore,
  ParsedCheckpoint,
} from "./build-receipt-offline.js";
export {
  buildReceiptOffline,
  computeAccumulatorPeak,
  openMassifNodeStore,
  parseCheckpoint,
} from "./build-receipt-offline.js";
/**
 * MMR proof math now lives in @forestrie/merklelog (plan-2607-15 §4 hoist);
 * re-exported here to preserve the receipt-verify public surface.
 */
export { peakMMRIndexes } from "@forestrie/merklelog";
export { decodeTrustRootFromGenesis } from "./decode-trust-root-from-genesis.js";
export { verifyGrantReceiptOffline } from "./verify-grant-receipt-offline.js";
export { verifyReceiptOffline } from "./verify-grant-receipt-offline.js";
/**
 * Caller-supplied trust anchors (FOR-297 "known log key"): verify offline
 * under keys the caller trusts out of band instead of the genesis trust root.
 * See the trust-ladder notes on verifyReceiptOfflineWithKeys.
 */
export {
  verifyGrantReceiptOfflineWithKeys,
  verifyReceiptOfflineWithKeys,
} from "./verify-grant-receipt-offline.js";
export type {
  VerifyGrantReceiptOfflineWithKeysInput,
  VerifyReceiptOfflineWithKeysInput,
} from "./verify-grant-receipt-offline.js";
export { resolveDelegatedVerifyKey } from "./resolve-delegated-verify-key.js";
export type { DelegatedResolution } from "./resolve-delegated-verify-key.js";
/** Import a raw 64-byte x||y P-256 public key as an ES256 verify key. */
export { importEs256PublicKeyFromGrantDataXy64 } from "./decode-trust-root-cbor.js";
export { decodeForestrieGrantCose } from "./decode-forestrie-grant-cose.js";
export { decodeGrantPayload, decodeGrantResponse } from "./grant-codec.js";

/** Deterministic receipt construction (plan-2607-12 Phase 2, FOR-353). */
export {
  HEADER_RECEIPT,
  attachReceiptAndIdtimestampToTransparentStatement,
} from "./attach-transparent-statement-receipt.js";
export { decodeEntryIdHex, entryIdHexToIdtimestampBe8 } from "./entry-id.js";
export type { DecodedEntryId } from "./entry-id.js";

/** Grant commitment hash (ContentHash) — the value the sequencer commits. */
export { grantCommitmentHashFromGrant } from "./grant-commitment.js";
/** Offline grant-leaf lookup from a local massif blob (FOR-344). */
export { findGrantLeafInMassif } from "./find-grant-leaf.js";
export type { LocatedLeaf } from "./find-grant-leaf.js";
/** Re-exported so callers of findGrantLeafInMassif can catch it (FOR-344). */
export { MissingIndexError } from "@forestrie/merklelog";
export {
  accumulatorPayload,
  checkpointConsistencyProof,
  computeCheckpointAccumulator,
  verifyCheckpointChain,
  type CheckpointChainLink,
  type CheckpointChainResult,
  type CheckpointConsistencyProof,
} from "./checkpoint-chain.js";
