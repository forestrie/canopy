import { describe, it, expect } from "vitest";
import { grantCommitmentHashFromGrant } from "../src/grant-commitment.js";
import { findGrantLeafInMassif } from "../src/find-grant-leaf.js";
import { MissingIndexError } from "@forestrie/merklelog";
import { buildV2MassifBytes } from "./helpers/massif-checkpoint-fixture.js";
import { grantWithData } from "./helpers/grant-receipt-fixture.js";

const LOG_ID = "660e8400-e29b-41d4-a716-446655440001";

function node(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

describe("findGrantLeafInMassif (FOR-344)", () => {
  it("locates the grant leaf and recovers its mmrIndex + idtimestamp", async () => {
    // Grant sequenced at leaf ordinal 1 (mmrIndex 1); a different grant at 0.
    const grant0 = grantWithData(LOG_ID, new Uint8Array(64).fill(0xaa));
    const grant = grantWithData(LOG_ID, new Uint8Array(64).fill(0xbb));
    const inner0 = await grantCommitmentHashFromGrant(grant0);
    const inner = await grantCommitmentHashFromGrant(grant);
    const id0 = new Uint8Array(8).fill(0x01);
    const idtimestampBe8 = new Uint8Array(8).fill(0x02);

    const massifBytes = buildV2MassifBytes({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [node(0xa0), node(0xa1), node(0xa2), node(0xa3)],
      leafRecords: [
        { idtimestampBe8: id0, valueBytes: inner0 },
        { idtimestampBe8, valueBytes: inner },
      ],
    });

    const located = await findGrantLeafInMassif(massifBytes, grant);
    expect(located).toEqual({ mmrIndex: 1n, idtimestampBe8 });
  });

  it("returns null when the grant is not in this massif", async () => {
    const grant = grantWithData(LOG_ID, new Uint8Array(64).fill(0xbb));
    const other = grantWithData(LOG_ID, new Uint8Array(64).fill(0xaa));
    const innerOther = await grantCommitmentHashFromGrant(other);
    const massifBytes = buildV2MassifBytes({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [node(0xa0), node(0xa1), node(0xa2), node(0xa3)],
      leafRecords: [
        { idtimestampBe8: new Uint8Array(8).fill(1), valueBytes: innerOther },
      ],
    });
    expect(await findGrantLeafInMassif(massifBytes, grant)).toBeNull();
  });

  it("throws MissingIndexError when the blob has no index region", async () => {
    const grant = grantWithData(LOG_ID, new Uint8Array(64).fill(0xbb));
    const full = buildV2MassifBytes({
      massifHeight: 3,
      massifIndex: 0,
      logHashes: [node(0xa0), node(0xa1), node(0xa2), node(0xa3)],
    });
    // Keep the full start header (256B) but truncate before the index region.
    const truncated = full.slice(0, 512);
    await expect(findGrantLeafInMassif(truncated, grant)).rejects.toThrow(
      MissingIndexError,
    );
  });
});
