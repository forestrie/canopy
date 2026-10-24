/**
 * ADR-0065 §4 admission over REAL-authenticator bytes (devdocs plan-2608-14
 * 1.3).
 *
 * The golden is a v2 session-key endorsement captured from Safari 26.2 /
 * macOS Touch ID via thinker scribe-ui's /goldens harness, plus one
 * per-turn leaf the endorsed session key signed with the endorsement at
 * unprotected -65801. It is frozen in receipt-verify (the package that owns
 * `verifySessionKeyEndorsement`), and its provenance is recorded there.
 * Here the same bytes go through {@link resolveEndorsedStatementSigner}, the
 * admission resolver register-signed-statement uses, so canopy's enforcement
 * point is pinned to what a real device emits, not only to the synthetic
 * assertions in register-statement-endorsed.test.ts.
 */

import { describe, expect, it } from "vitest";
import golden from "../../../libs/receipt-verify/test/fixtures/golden/session-key-endorsement-v2-real-authenticator.json";
import type { Grant } from "../src/grant";
import { uuidToBytes } from "../src/grant";
import { resolveEndorsedStatementSigner } from "../src/scrapi/endorsed-signer.js";

const DATA_LOG_ID = "de305d54-75b4-431b-adb2-eb6b9e546014";
const OWNER_LOG_ID = "660e8400-e29b-41d4-a716-446655440001";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Data-log statement grant rooted at `grantData`, UV required (byte 2). */
function uvDataLogGrant(grantData: Uint8Array): Grant {
  const flags = new Uint8Array(8);
  flags[2] = 0x01; // GF_REQUIRES_USER_VERIFICATION
  flags[3] = 0x03; // GF_CREATE | GF_EXTEND
  flags[7] = 0x02; // GF_DATA_LOG
  return {
    logId: uuidToBytes(DATA_LOG_ID),
    ownerLogId: uuidToBytes(OWNER_LOG_ID),
    grant: flags,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

const leaf = hexToBytes(golden.leaf.coseSign1);
const rootXy = hexToBytes(golden.rootX + golden.rootY);
const sessionXy = hexToBytes(golden.sessionX + golden.sessionY);
const notBefore = Number(golden.notBefore);
const notAfter = Number(golden.notAfter);

describe("endorsed-signer: real-authenticator v2 endorsement golden", () => {
  it("admits the leaf under the passkey root with UV, binding the endorsed session key", async () => {
    const resolved = await resolveEndorsedStatementSigner(
      leaf,
      uvDataLogGrant(rootXy),
      { nowMs: notBefore + 60_000 },
    );
    expect(resolved.kind).toBe("endorsed");
    if (resolved.kind !== "endorsed") return;
    expect(Array.from(resolved.sessionPublicKeyXY)).toEqual(
      Array.from(sessionXy),
    );
    expect(resolved.notBefore).toBe(notBefore);
    expect(resolved.notAfter).toBe(notAfter);
  });

  it("refuses it after the endorsement window", async () => {
    const resolved = await resolveEndorsedStatementSigner(
      leaf,
      uvDataLogGrant(rootXy),
      { nowMs: notAfter + 1 },
    );
    expect(resolved.kind).toBe("rejected");
    if (resolved.kind !== "rejected") return;
    expect(resolved.reason).toBe("endorsement_expired");
  });

  it("refuses it under a grant rooted at any other key, never falling back", async () => {
    // The session key itself as grantData: a well-formed 64-byte root that
    // did not sign the endorsement.
    const resolved = await resolveEndorsedStatementSigner(
      leaf,
      uvDataLogGrant(sessionXy),
      { nowMs: notBefore + 60_000 },
    );
    expect(resolved.kind).toBe("rejected");
    if (resolved.kind !== "rejected") return;
    expect(resolved.reason).toBe("endorsement_root_mismatch");
  });
});
