/**
 * Real-authenticator v2 session-key endorsement golden (devdocs
 * plan-2608-14 1.3; ADR-0065 §3).
 *
 * test/fixtures/golden/session-key-endorsement-v2-real-authenticator.json was
 * captured from a REAL platform authenticator (Safari 26.2 / macOS Touch ID)
 * through thinker scribe-ui's dev-only /goldens harness
 * (`captureEndorsementGolden`): a throwaway passkey endorses a throwaway
 * session key over the same fixed window as the synthetic suites, and the
 * session key signs one canonical per-turn leaf carrying the endorsement at
 * unprotected -65801. Provenance:
 * session-key-endorsement-v2-real-authenticator.provenance.md.
 *
 * The synthetic suites (session-key-endorsement.test.ts,
 * verify-endorsed-leaf.test.ts) build assertions in-test; these bytes come
 * from an authenticator, so they pin what a real device emits (BE|BS flags,
 * Safari's clientDataJSON) against the same verify path canopy admission and
 * `verifyEndorsedLeaf` run. Regeneration is a deliberate owner act and is
 * never byte-identical (fresh challenge and signature).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import {
  checkEndorsementWindow,
  SESSION_KEY_ENDORSEMENT_CONTENT_TYPE,
  verifySessionKeyEndorsement,
} from "../src/session-key-endorsement.js";
import { extractLeafEndorsement } from "../src/verify-endorsed-leaf.js";

interface EndorsementGolden {
  origin: string;
  rpId: string;
  contentType: string;
  rootX: string;
  rootY: string;
  sessionX: string;
  sessionY: string;
  notBefore: string;
  notAfter: string;
  endorsement: {
    coseSign1: string;
    payload: string;
    sigStructure: string;
    challengeB64u: string;
    authenticatorData: string;
    clientDataJSON: string;
  };
  leaf: { coseSign1: string; kid: string };
}

const golden = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "fixtures/golden/session-key-endorsement-v2-real-authenticator.json",
    ),
    "utf8",
  ),
) as EndorsementGolden;

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const rootKey = {
  x: hexToBytes(golden.rootX),
  y: hexToBytes(golden.rootY),
  curve: "P-256" as const,
};
const sessionKey = {
  x: hexToBytes(golden.sessionX),
  y: hexToBytes(golden.sessionY),
  curve: "P-256" as const,
};
const endorsement = hexToBytes(golden.endorsement.coseSign1);
const leaf = hexToBytes(golden.leaf.coseSign1);
const window = {
  notBefore: Number(golden.notBefore),
  notAfter: Number(golden.notAfter),
};

/** WebAuthn authenticatorData flag bits (byte 32). */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

describe("real-authenticator v2 session-key endorsement golden", () => {
  it("is the v2 artifact a real device produced for this origin", () => {
    expect(golden.contentType).toBe(SESSION_KEY_ENDORSEMENT_CONTENT_TYPE);
    expect(golden.rpId).toBe("localhost");

    const clientData = JSON.parse(
      new TextDecoder().decode(hexToBytes(golden.endorsement.clientDataJSON)),
    ) as { type: string; challenge: string; origin: string };
    expect(clientData.type).toBe("webauthn.get");
    expect(clientData.origin).toBe(golden.origin);

    // UP|UV|BE|BS: a synced platform passkey, user-verified. No synthetic
    // vector sets BE|BS.
    const flags = hexToBytes(golden.endorsement.authenticatorData)[32]!;
    expect(flags & FLAG_UP).toBe(FLAG_UP);
    expect(flags & FLAG_UV).toBe(FLAG_UV);
    expect(flags & FLAG_BE).toBe(FLAG_BE);
    expect(flags & FLAG_BS).toBe(FLAG_BS);
  });

  it("binds the WebAuthn challenge to sha256(Sig_structure) (ADR-0063 §3)", async () => {
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        hexToBytes(golden.endorsement.sigStructure),
      ),
    );
    expect(base64UrlEncode(digest)).toBe(golden.endorsement.challengeB64u);
  });

  it("verifies under the passkey root with UV and yields the session key and window", async () => {
    const verified = await verifySessionKeyEndorsement(endorsement, rootKey, {
      requireUserVerification: true,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(Array.from(verified.sessionPublicKeyXY)).toEqual(
      Array.from(concat(sessionKey.x, sessionKey.y)),
    );
    expect(verified.notBefore).toBe(window.notBefore);
    expect(verified.notAfter).toBe(window.notAfter);
  });

  it("is refused under any other root (kid pinned to root x)", async () => {
    const otherRoot = { ...sessionKey };
    const verified = await verifySessionKeyEndorsement(endorsement, otherRoot, {
      requireUserVerification: true,
    });
    expect(verified).toEqual({ ok: false, reason: "kid_mismatch" });
  });

  it("is refused when one payload byte changes", async () => {
    const tampered = endorsement.slice();
    const payloadAt = golden.endorsement.coseSign1.indexOf(
      golden.endorsement.payload,
    );
    expect(payloadAt).toBeGreaterThan(0);
    // Flip the last byte of the endorsed session key (inside the payload).
    const at = payloadAt / 2 + golden.endorsement.payload.length / 2 - 1;
    tampered[at] = tampered[at]! ^ 0x01;
    const verified = await verifySessionKeyEndorsement(tampered, rootKey, {
      requireUserVerification: true,
    });
    expect(verified.ok).toBe(false);
  });

  it("window: inside is valid, after notAfter is expired", () => {
    expect(checkEndorsementWindow(window, window.notBefore + 1).ok).toBe(true);
    expect(checkEndorsementWindow(window, window.notAfter + 1)).toEqual({
      ok: false,
      reason: "endorsement_expired",
    });
  });

  it("the leaf carries the exact endorsement at -65801 and is signed by the session key, not the root", async () => {
    const extracted = extractLeafEndorsement(leaf);
    expect(extracted.kind).toBe("ok");
    if (extracted.kind !== "ok") return;
    expect(Array.from(extracted.endorsement)).toEqual(Array.from(endorsement));
    expect(Array.from(extracted.kid ?? [])).toEqual(
      Array.from(hexToBytes(golden.leaf.kid)),
    );
    expect(Array.from(extracted.kid ?? [])).toEqual(Array.from(sessionKey.x));

    expect(await verifyCoseSign1WithParsedKey(leaf, sessionKey)).toBe(true);
    expect(await verifyCoseSign1WithParsedKey(leaf, rootKey)).toBe(false);
  });
});
