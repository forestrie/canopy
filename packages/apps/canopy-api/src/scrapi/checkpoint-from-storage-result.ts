import type { Hex } from "viem";

export interface CheckpointFromStorage {
  /** MMR root when present in checkpoint payload; optional for minimal verification. */
  mmrRoot?: Hex;
  /**
   * The checkpoint's SIGNED `tree-size-2` (protected header label -65933;
   * ADR-0066 D2/D3, FOR-568) — the sealed size the checkpoint's signature
   * covers, present only when `decodeCheckpointPayload` found both signed
   * tree-size labels alongside the consistency proof.
   */
  signedTreeSize2?: bigint;
}
