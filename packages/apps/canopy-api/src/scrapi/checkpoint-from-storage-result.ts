import type { Hex } from "viem";

export interface CheckpointFromStorage {
  /** MMR root when present in checkpoint payload; optional for minimal verification. */
  mmrRoot?: Hex;
}
