/**
 * Session-key endorsement label -65801 (devdocs ADR-0065 §2, plan-2608-14 1.1).
 *
 * The endorsement rides every endorsed leaf's unprotected header at -65801.
 * The plain-ES256 verify path is UNAWARE of it by design: it must ignore the
 * entry (the leaf verifies under the endorsed SESSION key), and an unaware
 * verifier holding only the ROOT must FAIL to verify an endorsed leaf — the
 * endorsement is the only route from root to leaf signer. -65800 (the
 * WebAuthn envelope) is never an endorsement: on a plain-ES256 leaf it stays
 * a fail-closed rejection.
 */

import { describe, expect, it } from "vitest";
import {
  COSE_ALG_ES256,
  COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  WEBAUTHN_ENVELOPE_LABEL,
  verifyCoseSign1WithParsedKey,
} from "./index.js";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { encodeCoseSign1Raw } from "./encode-cose-sign1-raw.js";
import { encodeSigStructure } from "./encode-sig-structure.js";

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

/** Plain-ES256 leaf signed by `signer`, with optional unprotected entries. */
async function buildEs256Leaf(
  signer: CryptoKeyPair,
  unprotected: Map<number, unknown>,
): Promise<Uint8Array> {
  const protectedBstr = encodeCborDeterministic(
    new Map<number, unknown>([[1, COSE_ALG_ES256]]),
  );
  const payload = new TextEncoder().encode("per-turn user envelope");
  const sigStructure = encodeSigStructure(
    protectedBstr,
    new Uint8Array(0),
    payload,
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signer.privateKey,
      new Uint8Array(sigStructure),
    ),
  );
  return encodeCoseSign1Raw(protectedBstr, unprotected, payload, signature);
}

describe("COSE_LABEL_SESSION_KEY_ENDORSEMENT (ADR-0065)", () => {
  it("is -65801 and distinct from the -65800 WebAuthn envelope label", () => {
    expect(COSE_LABEL_SESSION_KEY_ENDORSEMENT).toBe(-65801);
    expect(COSE_LABEL_SESSION_KEY_ENDORSEMENT).not.toBe(
      WEBAUTHN_ENVELOPE_LABEL,
    );
  });

  it("plain verify ignores a -65801 entry: an endorsed leaf verifies under the session key and FAILS under the root", async () => {
    const root = await generateKeyPair();
    const session = await generateKeyPair();
    const endorsementStandIn = new Uint8Array(64).fill(0xee);
    const leaf = await buildEs256Leaf(
      session,
      new Map([[COSE_LABEL_SESSION_KEY_ENDORSEMENT, endorsementStandIn]]),
    );
    expect(await verifyCoseSign1WithParsedKey(leaf, session.publicKey)).toBe(
      true,
    );
    // The pinned property: nothing in the plain path lets a verifier that
    // knows only the root accept a session-signed leaf.
    expect(await verifyCoseSign1WithParsedKey(leaf, root.publicKey)).toBe(
      false,
    );
  });

  it("a -65800 entry on a plain-ES256 leaf still fails closed — never read as an endorsement", async () => {
    const session = await generateKeyPair();
    const leaf = await buildEs256Leaf(
      session,
      new Map([[WEBAUTHN_ENVELOPE_LABEL, new Uint8Array(64).fill(0xee)]]),
    );
    expect(await verifyCoseSign1WithParsedKey(leaf, session.publicKey)).toBe(
      false,
    );
  });
});
