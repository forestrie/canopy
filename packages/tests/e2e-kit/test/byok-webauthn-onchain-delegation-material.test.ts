/**
 * WebAuthn (passkey-root) BYOK delegation material (plan-2608-13 phase 2):
 * two synthetic assertions per ceremony — the certificate's ADR-0063 envelope
 * and the on-chain ADR-0008 assertion — each independently verifiable by its
 * own contract-mirror verifier.
 */

import { describe, expect, it } from "vitest";
import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";
import {
  assembleWebauthnDelegationAlgData,
  decodeDelegatedCoseKeyFromBytes,
  encodeIntKeyCbor,
  normalizeEs256SignatureLowS,
  parseDelegatedCoseKeyFromPayload,
  verifyDelegationCertificateEs256,
  verifyOnchainDelegationSignatureWebauthn,
} from "@forestrie/delegation-cose";
import {
  buildByokDelegationMaterialWebauthn,
  exportEs256RootXy,
  generateEs256RootKeyPair,
} from "../src/coordinator-delegation-helpers.js";

function testDelegatedCoseKey(seed: number): Uint8Array {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    x[i] = (seed + i) & 0xff;
    y[i] = (seed + 100 + i) & 0xff;
  }
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [1, 2],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
}

describe("buildByokDelegationMaterialWebauthn", () => {
  it("builds a two-assertion ceremony, each artifact self-verifying", async () => {
    const rootKeyPair = await generateEs256RootKeyPair();
    const root = await exportEs256RootXy(rootKeyPair);
    const delegatedPublicKey = testDelegatedCoseKey(5);
    const logIdHex32 = "101112131415161718191a1b1c1d1e1f";

    const material = await buildByokDelegationMaterialWebauthn({
      rootKeyPair,
      logIdHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });

    // Certificate: verifies through the ADR-0063 envelope branch (UV set by
    // the synthetic authenticator), never through a plain ES256 verify.
    expect(
      await verifyCoseSign1WithParsedKey(
        material.certificate,
        { x: root.x, y: root.y, curve: "P-256" },
        { requireUserVerification: true },
      ),
    ).toBe(true);
    expect(
      await verifyDelegationCertificateEs256(
        material.certificate,
        rootKeyPair.publicKey,
      ),
    ).toBe(false);

    // On-chain assertion: low-s wire form, contract-mirror verifiable.
    expect(material.onchainSignature).toBeDefined();
    expect(material.onchainSignature!.length).toBe(64);
    expect(Array.from(material.onchainSignature!)).toEqual(
      Array.from(normalizeEs256SignatureLowS(material.onchainSignature!)),
    );
    expect(material.onchainAuthenticatorData).toBeDefined();
    expect(material.onchainClientDataJSON).toBeDefined();

    const { x, y } = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
    );
    const algData = assembleWebauthnDelegationAlgData(
      material.onchainAuthenticatorData!,
      material.onchainClientDataJSON!,
    );
    expect(
      await verifyOnchainDelegationSignatureWebauthn(
        {
          logIdHex: logIdHex32,
          mmrStart: 0,
          mmrEnd: 16383,
          delegatedKeyX: x,
          delegatedKeyY: y,
        },
        material.onchainSignature!,
        algData,
        root.x,
        root.y,
        { requireUserVerification: true },
      ),
    ).toBe(true);

    // The two assertions are distinct gestures (ADR-0063 §1): different
    // challenges, so different signed bytes.
    expect(
      await verifyOnchainDelegationSignatureWebauthn(
        {
          logIdHex: logIdHex32,
          mmrStart: 0,
          mmrEnd: 12,
          delegatedKeyX: x,
          delegatedKeyY: y,
        },
        material.onchainSignature!,
        algData,
        root.x,
        root.y,
      ),
    ).toBe(false);
  });
});
