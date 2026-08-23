/**
 * ES256_WEBAUTHN on-chain delegation proof (univocity ADR-0008, plan-2608-13
 * 1.2/1.5). Goldens generated from the univocity Solidity implementation
 * (`buildSigStructure` + `Base64.encodeURL` + `vm.signP256`, commit of
 * univocity v0.2.0) so the TS mirror is pinned byte-identical to what the
 * contract verifies: same TBS → same challenge → same digest. The synthetic
 * assertion below is signed by forge's deterministic P-256 key `pk = 1` over
 * exactly what a real authenticator signs.
 */

import { describe, expect, it } from "vitest";
import {
  assembleWebauthnDelegationAlgData,
  buildOnchainDelegationToBeSignedWebauthn,
  normalizeEs256SignatureLowS,
  verifyOnchainDelegationSignatureWebauthn,
  type OnchainDelegationInput,
} from "../src/index.js";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const FIXTURE_LOG_ID_HEX = "101112131415161718191a1b1c1d1e1f";
const FIXTURE_MMR_START = 3n;
const FIXTURE_MMR_END = 1n << 40n;
const FIXTURE_X = new Uint8Array(32).map((_, i) => 0xa0 + i);
const FIXTURE_Y = new Uint8Array(32).map((_, i) => 0xc0 + i);

// Solidity goldens (forge, univocity): protected header {1: -65800}, payload
// = domain ‖ logId32 ‖ mmrStart ‖ mmrEnd ‖ x ‖ y — the WebAuthn TBS.
const FIXTURE_PROTECTED_HEX = "a1013a00010107";
const FIXTURE_SIGSTRUCTURE_HEX =
  "846a5369676e61747572653147a1013a00010107405891666f726573747269652e756e69766f636974792e64656c65676174696f6e2e763100000000000000000000000000000000101112131415161718191a1b1c1d1e1f00000000000000030000010000000000a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf";
const FIXTURE_CHALLENGE = "vQcMFnx-7YDDnY1v2UzlKF_n68oSQMrziqo_5lInDSo";

// Synthetic assertion for the fixture TBS, signed by forge's deterministic
// P-256 key pk=1 (rootX/rootY = the generator point), RFC 6979 nonce,
// low-s normalized. authData = sha256("thinker.example") ‖ 0x01 (UP) ‖
// signCount 1; digest = sha256(authData ‖ sha256(clientDataJSON)).
const FIXTURE_ROOT_X_HEX =
  "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296";
const FIXTURE_ROOT_Y_HEX =
  "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
const FIXTURE_CLIENT_DATA = `{"type":"webauthn.get","challenge":"${FIXTURE_CHALLENGE}","origin":"https://thinker.example","crossOrigin":false}`;
const FIXTURE_AUTH_DATA_HEX =
  "fa8a19b4ae99255cc3d4b57320d26f7dfc3756d268fcb3b3cdf02ddb554dfbd10100000001";
const FIXTURE_SIGNATURE_HEX =
  "bb71fae6f25108a5786d84d9e3890959a3798ebe7b373fde94846bb9a69f7586" +
  "0818cf3d918ca6705c79dd598039f8557b3ff7f3a8bfb85f35b84c4715bdd6df";
const FIXTURE_RP_ID_HASH_HEX =
  "fa8a19b4ae99255cc3d4b57320d26f7dfc3756d268fcb3b3cdf02ddb554dfbd1";

function fixtureInput(): OnchainDelegationInput {
  return {
    logIdHex: FIXTURE_LOG_ID_HEX,
    mmrStart: FIXTURE_MMR_START,
    mmrEnd: FIXTURE_MMR_END,
    delegatedKeyX: FIXTURE_X,
    delegatedKeyY: FIXTURE_Y,
  };
}

function fixtureAlgData(): Uint8Array[] {
  return assembleWebauthnDelegationAlgData(
    hexToBytes(FIXTURE_AUTH_DATA_HEX),
    new TextEncoder().encode(FIXTURE_CLIENT_DATA),
  );
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
}

describe("buildOnchainDelegationToBeSignedWebauthn — Solidity vector cross-check", () => {
  it("produces the Sig_structure the contract rebuilds (same TBS)", () => {
    const tbs = buildOnchainDelegationToBeSignedWebauthn(fixtureInput());
    expect(bytesToHex(tbs.protectedHeader)).toBe(FIXTURE_PROTECTED_HEX);
    expect(bytesToHex(tbs.sigStructureBytes)).toBe(FIXTURE_SIGSTRUCTURE_HEX);
    expect(bytesToHex(tbs.delegationKey)).toBe(
      bytesToHex(FIXTURE_X) + bytesToHex(FIXTURE_Y),
    );
  });

  it("yields the challenge the contract compares (same challenge)", async () => {
    const tbs = buildOnchainDelegationToBeSignedWebauthn(fixtureInput());
    const { base64UrlEncode } = await import("@forestrie/encoding");
    expect(base64UrlEncode(await sha256(tbs.sigStructureBytes))).toBe(
      FIXTURE_CHALLENGE,
    );
  });
});

describe("verifyOnchainDelegationSignatureWebauthn — contract mirror", () => {
  const rootX = hexToBytes(FIXTURE_ROOT_X_HEX);
  const rootY = hexToBytes(FIXTURE_ROOT_Y_HEX);

  it("accepts the forge-signed synthetic assertion (same digest)", async () => {
    const ok = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      hexToBytes(FIXTURE_SIGNATURE_HEX),
      fixtureAlgData(),
      rootX,
      rootY,
    );
    expect(ok).toBe(true);
  });

  it("accepts under a matching pinned rpIdHash, rejects a mismatch", async () => {
    const okPinned = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      hexToBytes(FIXTURE_SIGNATURE_HEX),
      fixtureAlgData(),
      rootX,
      rootY,
      { requiredRpIdHash: hexToBytes(FIXTURE_RP_ID_HASH_HEX) },
    );
    expect(okPinned).toBe(true);
    const okEvil = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      hexToBytes(FIXTURE_SIGNATURE_HEX),
      fixtureAlgData(),
      rootX,
      rootY,
      { requiredRpIdHash: new Uint8Array(32).fill(0xee) },
    );
    expect(okEvil).toBe(false);
  });

  it("rejects when UV is required but the assertion carries UP only", async () => {
    const ok = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      hexToBytes(FIXTURE_SIGNATURE_HEX),
      fixtureAlgData(),
      rootX,
      rootY,
      { requireUserVerification: true },
    );
    expect(ok).toBe(false);
  });

  it("rejects a challenge bound to a different delegation scope", async () => {
    // Same consistently-signed assertion, different delegated key: key
    // possession proven, THIS delegation not bound (challenge mismatch).
    const ok = await verifyOnchainDelegationSignatureWebauthn(
      { ...fixtureInput(), delegatedKeyX: new Uint8Array(32).fill(0x01) },
      hexToBytes(FIXTURE_SIGNATURE_HEX),
      fixtureAlgData(),
      rootX,
      rootY,
    );
    expect(ok).toBe(false);
  });

  it("rejects a registration ceremony (webauthn.create)", async () => {
    const clientData = FIXTURE_CLIENT_DATA.replace(
      "webauthn.get",
      "webauthn.create",
    );
    const algData = [
      hexToBytes(FIXTURE_AUTH_DATA_HEX),
      new TextEncoder().encode(clientData),
      fixtureAlgData()[2]!,
    ];
    const ok = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      hexToBytes(FIXTURE_SIGNATURE_HEX),
      algData,
      rootX,
      rootY,
    );
    expect(ok).toBe(false);
  });

  it("rejects missing user presence and BS-without-BE flag states", async () => {
    for (const flags of [0x04 /* UV only */, 0x11 /* UP|BS, no BE */]) {
      const authData = hexToBytes(FIXTURE_AUTH_DATA_HEX);
      authData[32] = flags;
      const algData = [
        authData,
        new TextEncoder().encode(FIXTURE_CLIENT_DATA),
        fixtureAlgData()[2]!,
      ];
      const ok = await verifyOnchainDelegationSignatureWebauthn(
        fixtureInput(),
        hexToBytes(FIXTURE_SIGNATURE_HEX),
        algData,
        rootX,
        rootY,
      );
      expect(ok).toBe(false);
    }
  });

  it("rejects malformed algData shapes (count, truncation, indices)", async () => {
    const good = fixtureAlgData();
    const cases: Uint8Array[][] = [
      [good[0]!, good[1]!], // 2 elements
      [good[0]!, good[1]!, good[2]!, good[2]!], // 4 elements
      [good[0]!.subarray(0, 33), good[1]!, good[2]!], // authData < 37
      [good[0]!, good[1]!, hexToBytes("0017")], // indices not 16 bytes
    ];
    for (const algData of cases) {
      const ok = await verifyOnchainDelegationSignatureWebauthn(
        fixtureInput(),
        hexToBytes(FIXTURE_SIGNATURE_HEX),
        algData,
        rootX,
        rootY,
      );
      expect(ok).toBe(false);
    }
  });

  it("rejects the malleable high-s twin the contract rejects", async () => {
    const n = BigInt(
      "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
    );
    const sig = hexToBytes(FIXTURE_SIGNATURE_HEX);
    let s = 0n;
    for (let i = 32; i < 64; i++) {
      s = (s << 8n) | BigInt(sig[i]!);
    }
    const high = new Uint8Array(64);
    high.set(sig.subarray(0, 32), 0);
    const sHigh = n - s;
    for (let i = 0; i < 32; i++) {
      high[63 - i] = Number((sHigh >> BigInt(8 * i)) & 0xffn);
    }
    expect(Array.from(normalizeEs256SignatureLowS(high))).toEqual(
      Array.from(sig),
    );
    const ok = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      high,
      fixtureAlgData(),
      rootX,
      rootY,
    );
    expect(ok).toBe(false);
  });

  it("rejects a signature by a different key and wrong-length signatures", async () => {
    const okWrongKey = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      hexToBytes(FIXTURE_SIGNATURE_HEX),
      fixtureAlgData(),
      new Uint8Array(32).fill(0x03),
      rootY,
    );
    expect(okWrongKey).toBe(false);
    const okShort = await verifyOnchainDelegationSignatureWebauthn(
      fixtureInput(),
      new Uint8Array(65),
      fixtureAlgData(),
      rootX,
      rootY,
    );
    expect(okShort).toBe(false);
  });
});
