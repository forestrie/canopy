/**
 * Completing a transparent statement by merging receipt + idtimestamp must not alter
 * signed bytes covered by COSE Sig_structure (protected + payload only).
 */

import { describe, expect, it, beforeAll } from "vitest";
import { verifyCoseSign1 } from "@canopy/encoding";
import type { Grant } from "../src/grant/grant.js";
import { attachReceiptAndIdtimestampToTransparentStatement } from "../src/scrapi/attach-scitt-transparent-statement-receipt.js";
import { uuidToBytes } from "../src/grant/uuid-bytes.js";
import { encodeCustodianProfileForestrieGrant } from "./helpers/custodian-transparent-grant.js";

const TEST_KID = new Uint8Array(16).fill(0xcd);

let testPrivateKey: CryptoKey;
let testPublicKey: CryptoKey;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  testPrivateKey = pair.privateKey;
  testPublicKey = pair.publicKey;
});

function minimalGrant(logUuid: string): Grant {
  const id16 = uuidToBytes(logUuid);
  const grantBitmap = new Uint8Array(8);
  grantBitmap[4] = 0x03;
  grantBitmap[7] = 0x01;
  return {
    logId: id16,
    ownerLogId: id16,
    grant: grantBitmap,
    maxHeight: 0,
    minGrowth: 0,
    grantData: new Uint8Array(64).fill(0xee),
  };
}

describe("attachReceiptAndIdtimestampToTransparentStatement", () => {
  it("preserves ES256 signature after merging unprotected headers", async () => {
    const grant = minimalGrant("bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb");
    const base = await encodeCustodianProfileForestrieGrant(
      grant,
      testPrivateKey,
      TEST_KID,
      new Uint8Array(8),
    );
    expect(await verifyCoseSign1(base, testPublicKey)).toBe(true);

    const completed = attachReceiptAndIdtimestampToTransparentStatement(
      base,
      new Uint8Array([0xaa, 0xbb]),
      new Uint8Array(8).fill(0x11),
    );
    expect(await verifyCoseSign1(completed, testPublicKey)).toBe(true);
  });

  it("throws when idtimestamp is not 8 bytes", async () => {
    const grant = minimalGrant("cccccccc-cccc-4ccc-cccc-cccccccccccc");
    const base = await encodeCustodianProfileForestrieGrant(
      grant,
      testPrivateKey,
      TEST_KID,
      new Uint8Array(8),
    );
    expect(() =>
      attachReceiptAndIdtimestampToTransparentStatement(
        base,
        new Uint8Array(1),
        new Uint8Array(7),
      ),
    ).toThrow(/8 bytes/);
  });
});
