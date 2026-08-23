/**
 * WebAuthn assertion helpers: DER→P1363 conversion (what
 * `navigator.credentials.get` returns → the 64-byte wire form), clientDataJSON
 * index location, and the algData assemble/decode mirror of the contract's
 * normative `decodeWebAuthnDelegationAlgData`.
 */

import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/p256";
import {
  assembleWebauthnDelegationAlgData,
  decodeWebauthnDelegationAlgData,
  derSignatureToP1363,
  locateClientDataIndices,
} from "../src/index.js";

function derFromRs(r: Uint8Array, s: Uint8Array): Uint8Array {
  const int = (v: Uint8Array): number[] => {
    let b = Array.from(v);
    while (b.length > 1 && b[0] === 0 && (b[1]! & 0x80) === 0) b = b.slice(1);
    if (b[0]! & 0x80) b = [0, ...b];
    return [0x02, b.length, ...b];
  };
  const body = [...int(r), ...int(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

const CLIENT_DATA = new TextEncoder().encode(
  '{"type":"webauthn.get","challenge":"abc123","origin":"https://x.example","crossOrigin":false}',
);

describe("derSignatureToP1363", () => {
  it("round-trips signatures produced by a real P-256 signer", () => {
    const priv = p256.utils.randomPrivateKey();
    for (let i = 0; i < 8; i++) {
      const msg = new Uint8Array(32).fill(i + 1);
      const sig = p256.sign(msg, priv);
      const p1363 = derSignatureToP1363(sig.toDERRawBytes());
      expect(p1363.length).toBe(64);
      expect(Array.from(p1363)).toEqual(Array.from(sig.toCompactRawBytes()));
    }
  });

  it("strips DER sign padding and left-pads short components", () => {
    const r = new Uint8Array(32).fill(0xff); // high bit set → DER pads
    const s = new Uint8Array([0x01]); // single byte → wire left-pads
    const p1363 = derSignatureToP1363(derFromRs(r, s));
    expect(Array.from(p1363.subarray(0, 32))).toEqual(Array.from(r));
    expect(Array.from(p1363.subarray(32))).toEqual([
      ...new Array(31).fill(0),
      1,
    ]);
  });

  it("rejects malformed DER", () => {
    const good = derFromRs(
      new Uint8Array(32).fill(0x11),
      new Uint8Array(32).fill(0x22),
    );
    expect(() => derSignatureToP1363(new Uint8Array(0))).toThrow(/truncated/);
    expect(() => derSignatureToP1363(good.subarray(0, 10))).toThrow();
    const notSeq = new Uint8Array(good);
    notSeq[0] = 0x31;
    expect(() => derSignatureToP1363(notSeq)).toThrow(/SEQUENCE/);
    const trailing = new Uint8Array([...good, 0x00]);
    expect(() => derSignatureToP1363(trailing)).toThrow(/length mismatch/);
    // 33-byte component without a stripable sign pad
    const tooWide = derFromRs(
      new Uint8Array(33).fill(0x7f),
      new Uint8Array(32),
    );
    expect(() => derSignatureToP1363(tooWide)).toThrow(/exceeds 32 bytes/);
  });
});

describe("locateClientDataIndices", () => {
  it("locates the byte offsets the contract slice-compares", () => {
    const { challengeIndex, typeIndex } = locateClientDataIndices(CLIENT_DATA);
    // Browser field order: {"type":"webauthn.get","challenge":"...
    expect(typeIndex).toBe(1n);
    expect(challengeIndex).toBe(23n);
    const text = new TextDecoder().decode(CLIENT_DATA);
    expect(text.slice(Number(typeIndex), Number(typeIndex) + 21)).toBe(
      '"type":"webauthn.get"',
    );
    expect(
      text.slice(Number(challengeIndex), Number(challengeIndex) + 13),
    ).toBe('"challenge":"');
  });

  it("throws when a marker is absent", () => {
    expect(() =>
      locateClientDataIndices(
        new TextEncoder().encode('{"type":"webauthn.create"}'),
      ),
    ).toThrow(/webauthn.get/);
    expect(() =>
      locateClientDataIndices(
        new TextEncoder().encode('{"type":"webauthn.get"}'),
      ),
    ).toThrow(/challenge/);
  });
});

describe("assembleWebauthnDelegationAlgData / decodeWebauthnDelegationAlgData", () => {
  const authData = new Uint8Array(37).fill(0x0a);

  it("round-trips with derived indices in the normative packed layout", () => {
    const algData = assembleWebauthnDelegationAlgData(authData, CLIENT_DATA);
    expect(algData.length).toBe(3);
    expect(algData[2]!.length).toBe(16);
    const decoded = decodeWebauthnDelegationAlgData(algData);
    expect(decoded.authenticatorData).toBe(authData);
    expect(decoded.clientDataJSON).toBe(CLIENT_DATA);
    expect(decoded.challengeIndex).toBe(23n);
    expect(decoded.typeIndex).toBe(1n);
  });

  it("rejects short authenticatorData at assembly", () => {
    expect(() =>
      assembleWebauthnDelegationAlgData(new Uint8Array(36), CLIENT_DATA),
    ).toThrow(/37 bytes/);
  });

  it("decode enforces the contract's shape rules", () => {
    const good = assembleWebauthnDelegationAlgData(authData, CLIENT_DATA);
    expect(() => decodeWebauthnDelegationAlgData(good.slice(0, 2))).toThrow(
      /3 elements/,
    );
    expect(() =>
      decodeWebauthnDelegationAlgData([new Uint8Array(36), good[1]!, good[2]!]),
    ).toThrow(/37 bytes/);
    expect(() =>
      decodeWebauthnDelegationAlgData([good[0]!, good[1]!, new Uint8Array(15)]),
    ).toThrow(/16 bytes/);
  });
});
