import type { GrantData } from "./grant-data.js";

/** On-chain grant content aligned with Univocity `PublishGrant`. */
export interface Grant {
  logId: Uint8Array;
  grant: Uint8Array;
  request?: bigint;
  maxHeight?: number;
  minGrowth?: number;
  ownerLogId: Uint8Array;
  grantData: Uint8Array | GrantData;
}
