/**
 * Endorsed session leaves (devdocs ADR-0065, plan-2608-14 4.1): a synthetic
 * passkey root endorses a session key (v2, windowed) and the per-turn leaf is
 * signed by the SESSION key with the endorsement riding at unprotected label
 * -65801. What verifies here is what canopy admission and the offline rung
 * (`verifyEndorsedLeaf`) verify — the kit builds bytes, it never re-implements
 * the verifier.
 */

import { describe, expect, it } from "vitest";
import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";
import {
  extractLeafEndorsement,
  verifySessionKeyEndorsement,
} from "@forestrie/receipt-verify";
import {
  passkeySessionCustody,
  signEndorsedSessionStatement,
} from "../src/endorsed-session-leaf.js";

describe("endorsed session leaf", () => {
  it("signs a leaf under the endorsed session key with the v2 endorsement at -65801", async () => {
    const custody = await passkeySessionCustody();
    const payload = new TextEncoder().encode('{"turn":"hello"}');
    const leaf = await signEndorsedSessionStatement({ custody, payload });

    // The endorsement rides inside the leaf, byte-identical, kid = session x.
    const extracted = extractLeafEndorsement(leaf);
    expect(extracted.kind).toBe("ok");
    if (extracted.kind !== "ok") return;
    expect(Array.from(extracted.endorsement)).toEqual(
      Array.from(custody.endorsement),
    );
    expect(Array.from(extracted.kid!)).toEqual(
      Array.from(custody.sessionPublicKeyXY.subarray(0, 32)),
    );

    // Under the passkey root (UV enforced, as a UV grant demands) the
    // endorsement yields the session key the leaf verifies under.
    const root = {
      x: custody.rootPublicKeyXY.subarray(0, 32),
      y: custody.rootPublicKeyXY.subarray(32, 64),
      curve: "P-256" as const,
    };
    const endorsed = await verifySessionKeyEndorsement(
      extracted.endorsement,
      root,
      { requireUserVerification: true },
    );
    expect(endorsed.ok).toBe(true);
    if (!endorsed.ok) return;
    expect(Array.from(endorsed.sessionPublicKeyXY)).toEqual(
      Array.from(custody.sessionPublicKeyXY),
    );
    expect(await verifyCoseSign1WithParsedKey(leaf, endorsed.sessionKey)).toBe(
      true,
    );

    // An unaware verifier must FAIL to verify the leaf under the root
    // (ADR-0065 §1: the root signs ceremonies, never leaves).
    expect(await verifyCoseSign1WithParsedKey(leaf, root)).toBe(false);
  });
});
