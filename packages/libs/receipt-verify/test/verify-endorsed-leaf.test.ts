/**
 * verifyEndorsedLeaf — the single offline rung for a passkey-rooted log
 * (ADR-0065 §5, plan-2608-14 1.2): from public artifacts only,
 *
 *   root (grantData) → endorsement (-65801 inside the leaf) → session key
 *     → leaf (kid = session x, ES256 under the session key)
 *       → receipt (inclusion of the exact leaf bytes; receipted idtimestamp
 *         inside the endorsement window).
 *
 * Every rejection is a distinct stage/reason so a verifier can say WHICH
 * link broke, and no path verifies the leaf under the root.
 */

import { describe, expect, it } from "vitest";
import {
  COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  WEBAUTHN_ENVELOPE_LABEL,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import {
  buildSessionKeyEndorsementTbs,
  SESSION_KEY_ENDORSEMENT_V1_CONTENT_TYPE,
} from "../src/session-key-endorsement.js";
import { verifyEndorsedLeaf } from "../src/verify-endorsed-leaf.js";
import { generateP256KeyPair } from "./helpers/grant-receipt-fixture.js";
import {
  assembleSessionKeyEndorsementForTest,
  buildEndorsedLeaf,
  buildEndorsedLeafFixture,
  buildEndorsement,
  buildLeaf,
  buildReceiptOverStatement,
  exportXy,
  FLAG_UP,
  FLAG_UV,
  idtimestampBe8ForUnixMs,
  LEAF_MS,
  WINDOW,
} from "./helpers/endorsed-leaf-fixture.js";

describe("verifyEndorsedLeaf (ADR-0065 §5)", () => {
  it("happy path: root → endorsement → session leaf → receipt, window from the receipted idtimestamp", async () => {
    const f = await buildEndorsedLeafFixture();
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: f.rootXy,
      statementCbor: f.statement,
      receiptCbor: f.receipt,
      idtimestampBe8: f.idtimestampBe8,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionPublicKeyXY).toEqual(f.sessionXy);
    expect(result.notBefore).toBe(WINDOW.notBefore);
    expect(result.notAfter).toBe(WINDOW.notAfter);
    expect(result.leafIdtimestampMs).toBe(LEAF_MS);
  });

  it("rejects under the wrong root — the endorsement does not chain to this grantData", async () => {
    const f = await buildEndorsedLeafFixture();
    const other = await generateP256KeyPair();
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: await exportXy(other.publicKey),
      statementCbor: f.statement,
      receiptCbor: f.receipt,
      idtimestampBe8: f.idtimestampBe8,
      // Receipt trust is a separate rung; keep it satisfiable so the failure
      // is unambiguously the endorsement's.
      trustKeys: [f.root.publicKey],
    });
    expect(result).toEqual({
      ok: false,
      stage: "endorsement",
      reason: "endorsement_root_mismatch",
    });
  });

  it("rejects a leaf without an endorsement — never verifies a leaf under the root", async () => {
    // A 4a-shaped leaf (kid = root x, signed by the root) presented to the
    // endorsed rung: this rung has exactly one route and it starts at -65801.
    const root = await generateP256KeyPair();
    const rootXy = await exportXy(root.publicKey);
    const statement = await buildLeaf(root, rootXy.slice(0, 32), new Map());
    const idtimestampBe8 = idtimestampBe8ForUnixMs(LEAF_MS);
    const receipt = await buildReceiptOverStatement({
      sealer: root,
      statement,
      idtimestampBe8,
    });
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: rootXy,
      statementCbor: statement,
      receiptCbor: receipt,
      idtimestampBe8,
    });
    expect(result).toEqual({
      ok: false,
      stage: "endorsement",
      reason: "endorsement_missing",
    });
  });

  it("rejects when the receipted idtimestamp is outside the window, both directions", async () => {
    for (const [leafMs, reason] of [
      [WINDOW.notAfter + 1, "endorsement_expired"],
      [WINDOW.notBefore - 1, "endorsement_not_yet_valid"],
    ] as const) {
      const f = await buildEndorsedLeafFixture({ leafMs });
      const result = await verifyEndorsedLeaf({
        rootPublicKeyXY: f.rootXy,
        statementCbor: f.statement,
        receiptCbor: f.receipt,
        idtimestampBe8: f.idtimestampBe8,
      });
      expect(result).toEqual({ ok: false, stage: "window", reason });
    }
    // Both ends inclusive.
    for (const leafMs of [WINDOW.notBefore, WINDOW.notAfter]) {
      const f = await buildEndorsedLeafFixture({ leafMs });
      expect(
        (
          await verifyEndorsedLeaf({
            rootPublicKeyXY: f.rootXy,
            statementCbor: f.statement,
            receiptCbor: f.receipt,
            idtimestampBe8: f.idtimestampBe8,
          })
        ).ok,
      ).toBe(true);
    }
  });

  it("rejects a v1 (window-less) endorsement — not grandfathered", async () => {
    const root = await generateP256KeyPair();
    const session = await generateP256KeyPair();
    const rootXy = await exportXy(root.publicKey);
    const sessionXy = await exportXy(session.publicKey);
    const v1 = await assembleSessionKeyEndorsementForTest(root, {
      protectedMap: new Map<number, unknown>([
        [1, -65800],
        [3, SESSION_KEY_ENDORSEMENT_V1_CONTENT_TYPE],
        [4, rootXy.slice(0, 32)],
      ]),
      payloadBstr: encodeCborDeterministic(
        new Map<string, unknown>([["sessionKey", sessionXy]]),
      ),
    });
    const statement = await buildEndorsedLeaf(session, v1);
    const idtimestampBe8 = idtimestampBe8ForUnixMs(LEAF_MS);
    const receipt = await buildReceiptOverStatement({
      sealer: root,
      statement,
      idtimestampBe8,
    });
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: rootXy,
      statementCbor: statement,
      receiptCbor: receipt,
      idtimestampBe8,
    });
    expect(result).toEqual({
      ok: false,
      stage: "endorsement",
      reason: "endorsement_invalid",
    });
  });

  it("rejects a -65800 entry on the leaf itself — the envelope label is never an endorsement", async () => {
    const f = await buildEndorsedLeafFixture();
    const smuggled = await buildEndorsedLeaf(
      f.session,
      f.endorsement,
      new Map([
        [WEBAUTHN_ENVELOPE_LABEL, [new Uint8Array(37), new Uint8Array(2)]],
      ]),
    );
    const idtimestampBe8 = idtimestampBe8ForUnixMs(LEAF_MS);
    const receipt = await buildReceiptOverStatement({
      sealer: f.root,
      statement: smuggled,
      idtimestampBe8,
    });
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: f.rootXy,
      statementCbor: smuggled,
      receiptCbor: receipt,
      idtimestampBe8,
    });
    expect(result).toEqual({
      ok: false,
      stage: "leaf",
      reason: "leaf_signature_invalid",
    });
  });

  it("rejects a leaf whose kid is not the endorsed session x", async () => {
    const f = await buildEndorsedLeafFixture();
    // Signed by the session key, but claiming the ROOT's kid.
    const statement = await buildLeaf(
      f.session,
      f.rootXy.slice(0, 32),
      new Map([[COSE_LABEL_SESSION_KEY_ENDORSEMENT, f.endorsement]]),
    );
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: f.rootXy,
      statementCbor: statement,
      receiptCbor: f.receipt,
      idtimestampBe8: f.idtimestampBe8,
    });
    expect(result).toEqual({
      ok: false,
      stage: "leaf",
      reason: "signer_mismatch",
    });
  });

  it("tampered endorsement bytes: inclusion fails (contentHash covers the whole Sign1)", async () => {
    const f = await buildEndorsedLeafFixture();
    // Re-endorse the same session key under the same root with a wider
    // window: a VALID endorsement, but not the bytes that were committed.
    const reissued = await buildEndorsement(f.root, f.sessionXy, {
      notBefore: WINDOW.notBefore - 1000,
      notAfter: WINDOW.notAfter + 1000,
    });
    const swapped = await buildEndorsedLeaf(f.session, reissued);
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: f.rootXy,
      statementCbor: swapped,
      receiptCbor: f.receipt, // receipt over the ORIGINAL leaf bytes
      idtimestampBe8: f.idtimestampBe8,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("receipt");
    // canopy emits DETACHED-peak receipts: the peak is recomputed from the
    // (now different) leaf hash and the seal signature no longer matches it,
    // so the receipt rung reports `signature_invalid`; an explicit-peak
    // receipt would report `inclusion_failed`. Either way the rung is the
    // receipt and the leaf bytes are not the committed ones.
    expect(["inclusion_failed", "signature_invalid"]).toContain(result.reason);
  });

  it("substituted endorsement (another session key under the same root): the leaf signature fails", async () => {
    const f = await buildEndorsedLeafFixture();
    const attacker = await generateP256KeyPair();
    const attackerEndorsement = await buildEndorsement(
      f.root,
      await exportXy(attacker.publicKey),
      WINDOW,
    );
    // The honest session key signed the leaf; the attacker's endorsement is
    // spliced in (and the kid rewritten to the attacker's x).
    const spliced = await buildLeaf(
      f.session,
      (await exportXy(attacker.publicKey)).slice(0, 32),
      new Map([[COSE_LABEL_SESSION_KEY_ENDORSEMENT, attackerEndorsement]]),
    );
    const result = await verifyEndorsedLeaf({
      rootPublicKeyXY: f.rootXy,
      statementCbor: spliced,
      receiptCbor: f.receipt,
      idtimestampBe8: f.idtimestampBe8,
    });
    expect(result).toEqual({
      ok: false,
      stage: "leaf",
      reason: "leaf_signature_invalid",
    });
  });

  it("honours requireUserVerification with the distinct reason", async () => {
    const upOnly = await buildEndorsedLeafFixture({ flags: FLAG_UP });
    expect(
      await verifyEndorsedLeaf(
        {
          rootPublicKeyXY: upOnly.rootXy,
          statementCbor: upOnly.statement,
          receiptCbor: upOnly.receipt,
          idtimestampBe8: upOnly.idtimestampBe8,
        },
        { requireUserVerification: true },
      ),
    ).toEqual({
      ok: false,
      stage: "endorsement",
      reason: "endorsement_uv_required",
    });
    const upUv = await buildEndorsedLeafFixture({ flags: FLAG_UP | FLAG_UV });
    expect(
      (
        await verifyEndorsedLeaf(
          {
            rootPublicKeyXY: upUv.rootXy,
            statementCbor: upUv.statement,
            receiptCbor: upUv.receipt,
            idtimestampBe8: upUv.idtimestampBe8,
          },
          { requireUserVerification: true },
        )
      ).ok,
    ).toBe(true);
  });

  it("builder TBS with a malformed window cannot even be constructed", () => {
    expect(() =>
      buildSessionKeyEndorsementTbs({
        rootPublicKeyX: new Uint8Array(32),
        sessionPublicKeyXY: new Uint8Array(64),
        notBefore: 10,
        notAfter: 10,
      }),
    ).toThrow();
  });
});
