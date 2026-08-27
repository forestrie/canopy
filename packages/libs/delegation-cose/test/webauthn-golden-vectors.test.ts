/**
 * Real-authenticator WebAuthn delegation goldens (plan-2608-13 Phase 5.1).
 *
 * testdata/webauthn-real-authenticator-golden.json was captured from a REAL
 * platform authenticator via the thinker ceremony (`delegateSealingWebauthn`
 * driven by scribe-ui's dev-only /goldens harness) — closing ADR-0008's
 * stated debt ("a golden assertion captured from a real authenticator should
 * be added as a fixture once the thinker-side ceremony exists"). It also
 * freezes the first real ADR-0063 certificate envelope bytes.
 *
 * The scope (logId, mmr range, delegated-key patterns) matches the synthetic
 * family in testdata/onchain-delegation-vectors.json; regeneration is a
 * deliberate act — re-run the harness with a real authenticator.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  base64UrlEncode,
  verifyCoseSign1WithParsedKey,
} from "@forestrie/encoding";
import {
  assembleWebauthnDelegationAlgData,
  buildOnchainDelegationToBeSignedWebauthn,
  decodeWebauthnDelegationAlgData,
  parseDelegationCertificate,
  verifyOnchainDelegationSignatureWebauthn,
  WEBAUTHN_FLAG_UV,
  WEBAUTHN_FLAG_UP,
} from "../src/index.ts";

interface Golden {
  authenticator: string;
  logIdHex: string;
  mmrStart: string;
  mmrEnd: string;
  delegatedKeyX: string;
  delegatedKeyY: string;
  rootX: string;
  rootY: string;
  onchain: {
    protectedHeader: string;
    signature: string;
    authenticatorData: string;
    clientDataJSON: string;
    challengeIndex: string;
    typeIndex: string;
    sigStructure: string;
    challengeB64u: string;
  };
  certificate: {
    coseSign1: string;
    issuedAt: string;
    expiresAt: string;
    sigStructure: string;
    challengeB64u: string;
  };
}

const golden = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "testdata/webauthn-real-authenticator-golden.json",
    ),
    "utf8",
  ),
) as Golden;

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

const input = {
  logIdHex: golden.logIdHex,
  mmrStart: BigInt(golden.mmrStart),
  mmrEnd: BigInt(golden.mmrEnd),
  delegatedKeyX: hexToBytes(golden.delegatedKeyX),
  delegatedKeyY: hexToBytes(golden.delegatedKeyY),
};
const rootX = hexToBytes(golden.rootX);
const rootY = hexToBytes(golden.rootY);
const algData = assembleWebauthnDelegationAlgData(
  hexToBytes(golden.onchain.authenticatorData),
  hexToBytes(golden.onchain.clientDataJSON),
);

describe("real-authenticator golden (5.1)", () => {
  it("on-chain assertion verifies via the ADR-0008 contract mirror, UV enforced", async () => {
    expect(
      await verifyOnchainDelegationSignatureWebauthn(
        input,
        hexToBytes(golden.onchain.signature),
        algData,
        rootX,
        rootY,
        { requireUserVerification: true },
      ),
    ).toBe(true);
  });

  it("recorded TBS, challenge, and indices match a live rebuild", async () => {
    const tbs = buildOnchainDelegationToBeSignedWebauthn(input);
    expect(Buffer.from(tbs.sigStructureBytes).toString("hex")).toBe(
      golden.onchain.sigStructure,
    );
    expect(Buffer.from(tbs.protectedHeader).toString("hex")).toBe(
      golden.onchain.protectedHeader,
    );
    const challenge = new Uint8Array(
      await crypto.subtle.digest("SHA-256", tbs.sigStructureBytes),
    );
    expect(base64UrlEncode(challenge)).toBe(golden.onchain.challengeB64u);
    const decoded = decodeWebauthnDelegationAlgData(algData);
    expect(decoded.challengeIndex.toString()).toBe(
      golden.onchain.challengeIndex,
    );
    expect(decoded.typeIndex.toString()).toBe(golden.onchain.typeIndex);
  });

  it("real authenticatorData carries UP and UV", () => {
    const flags = hexToBytes(golden.onchain.authenticatorData)[32]!;
    expect(flags & WEBAUTHN_FLAG_UP).toBe(WEBAUTHN_FLAG_UP);
    expect(flags & WEBAUTHN_FLAG_UV).toBe(WEBAUTHN_FLAG_UV);
  });

  it("certificate verifies via the shared -65800 envelope branch, UV enforced", async () => {
    const certificate = hexToBytes(golden.certificate.coseSign1);
    expect(
      await verifyCoseSign1WithParsedKey(
        certificate,
        { x: rootX, y: rootY, curve: "P-256" },
        { requireUserVerification: true },
      ),
    ).toBe(true);
    const info = parseDelegationCertificate(certificate);
    expect(info.logIdHex32).toBe(golden.logIdHex);
    expect(String(info.issuedAt)).toBe(golden.certificate.issuedAt);
    expect(String(info.expiresAt)).toBe(golden.certificate.expiresAt);
  });

  it("tampered signatures fail closed", async () => {
    const badSig = hexToBytes(golden.onchain.signature);
    badSig[10]! ^= 0x01;
    expect(
      await verifyOnchainDelegationSignatureWebauthn(
        input,
        badSig,
        algData,
        rootX,
        rootY,
      ),
    ).toBe(false);

    const badCert = hexToBytes(golden.certificate.coseSign1);
    badCert[badCert.length - 10]! ^= 0x01;
    expect(
      await verifyCoseSign1WithParsedKey(badCert, {
        x: rootX,
        y: rootY,
        curve: "P-256",
      }),
    ).toBe(false);
  });
});
