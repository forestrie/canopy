/**
 * Rebuild a grant's receipt from MMRS checkpoint/massif (same path as resolve-receipt).
 * Used when verifying parent-grant evidence so delegation cert and inclusion proof
 * match what the sealer stored.
 */

import type { GrantResult } from "../grant/grant-result.js";
import { parseReceipt } from "../grant/receipt-verify.js";
import { bytesToUuid } from "../grant/uuid-bytes.js";
import { buildReceiptForEntry } from "./resolve-receipt.js";

export async function hydrateGrantReceiptFromMmrs(
  grantResult: GrantResult,
  r2Mmrs: R2Bucket,
  massifHeight: number,
): Promise<GrantResult> {
  const receipt = grantResult.receipt;
  if (!receipt?.proof) return grantResult;

  const mmrIndex =
    receipt.proof.mmrIndex ??
    (receipt.proof.leafIndex !== undefined
      ? receipt.proof.leafIndex
      : undefined);
  if (mmrIndex === undefined) return grantResult;

  // MMRS checkpoint/massif paths use the grant target log (logId), not ownerLogId.
  // Child auth grants seal on log A while ownerLogId remains root R.
  let sealLogUuid: string;
  try {
    sealLogUuid = bytesToUuid(grantResult.grant.logId);
  } catch {
    return grantResult;
  }

  const rebuilt = await buildReceiptForEntry(
    sealLogUuid,
    massifHeight,
    mmrIndex,
    r2Mmrs,
  );
  if (!rebuilt) return grantResult;

  try {
    const parsed = parseReceipt(rebuilt);
    return {
      ...grantResult,
      receipt: {
        coseSign1Bytes: rebuilt,
        explicitPeak: parsed.explicitPeak,
        proof: parsed.proof,
      },
    };
  } catch {
    return grantResult;
  }
}
