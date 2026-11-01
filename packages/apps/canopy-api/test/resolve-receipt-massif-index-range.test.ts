/**
 * FOR-621 review finding 3 (PR #281): an entryId is client-supplied, so its
 * mmrIndex can map to a massif index beyond what Go can write (uint32,
 * MAX_MASSIF_INDEX). Such an entry cannot exist in R2; the receipt path must
 * treat it as not found without logging it as an error.
 */
import { MAX_MASSIF_INDEX } from "@forestrie/merklelog";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildReceiptForEntry } from "../src/scrapi/resolve-receipt.js";

const LOG_ID = "b3333333-3333-4333-8333-333333333333";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildReceiptForEntry — massif index beyond Go uint32", () => {
  it("returns null without logging an error", async () => {
    const r2 = (env as unknown as { R2_MMRS: R2Bucket }).R2_MMRS;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Height 1 puts one leaf in each massif, so massif index == leaf index;
    // an mmrIndex near 2^64 is far above MAX_MASSIF_INDEX.
    const mmrIndex = (1n << 64n) - 2n;
    expect(mmrIndex).toBeGreaterThan(MAX_MASSIF_INDEX);

    await expect(buildReceiptForEntry(LOG_ID, 1, mmrIndex, r2)).resolves.toBe(
      null,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
