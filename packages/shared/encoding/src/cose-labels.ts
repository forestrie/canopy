/**
 * Shared COSE / VDP (verifiable-data-proofs) header label constants
 * (draft-bryce-cose-receipts-mmr-profile; forestrie protocol label registry;
 * ADR-0066 D3). Single source of truth — importers must not redeclare these
 * values locally.
 */

/**
 * COSE header label for algorithm (alg), RFC 9052 §3.1. Canonical home for
 * this value: `COSE_ALG` in `encode-cose-protected.ts` aliases this constant
 * rather than redeclaring `1`.
 */
export const COSE_LABEL_ALG = 1;

/**
 * Verifiable-data-signature protected header label
 * (draft-bryce-cose-receipts-mmr-profile; ADR-0066 D3).
 */
export const COSE_LABEL_VDS = 395;

/**
 * Verifiable-data-proofs unprotected header label, map-valued
 * (draft-bryce-cose-receipts-mmr-profile; forestrie protocol label registry;
 * ADR-0066 D3). Historically misnamed `VDS_COSE_RECEIPT_PROOFS_TAG` at a few
 * call sites — 396 is vdp, not vds.
 */
export const COSE_LABEL_VDP = 396;

/**
 * Inclusion proof key inside the vdp map
 * (draft-bryce-cose-receipts-mmr-profile; ADR-0066 D3).
 */
export const VDP_INCLUSION_PROOF_KEY = -1;

/**
 * Consistency proof key inside the vdp map, bstr-valued
 * (draft-bryce-cose-receipts-mmr-profile; ADR-0066 D3).
 */
export const VDP_CONSISTENCY_PROOF_KEY = -2;

/**
 * Pre-signed peak receipts unprotected header label (forestrie protocol
 * label registry; ADR-0066 D3).
 */
export const COSE_LABEL_PEAK_RECEIPTS = -65931;

/**
 * Delegation proof unprotected header label (forestrie protocol label
 * registry; ADR-0066 D3).
 */
export const COSE_LABEL_DELEGATION_PROOF = -66535;

/**
 * `tree-size-1` protected header label, uint (= -65535 - 397; ADR-0066 D3).
 */
export const COSE_LABEL_TREE_SIZE_1 = -65932;

/**
 * `tree-size-2` protected header label, uint (= -65535 - 398; ADR-0066 D3).
 */
export const COSE_LABEL_TREE_SIZE_2 = -65933;
