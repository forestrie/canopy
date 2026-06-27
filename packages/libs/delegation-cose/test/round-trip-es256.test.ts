/**
 * ES256 round-trip tests — build, verify, and parse against the arbor
 * [delegationcert](https://github.com/forestrie/arbor/tree/main/services/pkgs/delegationcert)
 * wire profile (inline field 5, int-key maps).
 */

import { decode } from "cbor-x";
import { describe, expect, it } from "vitest";
import {
  buildDelegationCertificateEs256,
  parseDelegationCertificate,
  verifyDelegationCertificateEs256,
} from "../src/index.js";
import {
  COSE_CRV,
  COSE_CRV_P256,
  COSE_KTY,
  COSE_KTY_EC2,
  COSE_X,
  COSE_Y,
  PAYLOAD_DELEGATED_KEY,
} from "../src/payload-labels.js";
import { encodeIntKeyCbor } from "../src/encode-int-map.js";
import { normalizeIntKeyedMap } from "../src/parse-delegated-cose-key.js";

/** Build a valid delegated EC2 P-256 COSE_Key CBOR blob for test inputs. */
async function generateDelegatedPublicKeyCbor(): Promise<Uint8Array> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_KTY, COSE_KTY_EC2],
      [COSE_CRV, COSE_CRV_P256],
      [COSE_X, x],
      [COSE_Y, y],
    ]),
  );
}

describe("ES256 delegation certificate", () => {
  it("round-trips assemble and verify", async () => {
    const rootKeyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const delegatedPublicKeyCbor = await generateDelegatedPublicKeyCbor();
    const logIdHex32 = "a1b2c3d4e5f67890abcdef1234567890ab";
    const issuedAt = 1_700_000_000;
    const expiresAt = issuedAt + 3600;

    const certificate = await buildDelegationCertificateEs256(
      {
        logIdHex32,
        mmrStart: 0,
        mmrEnd: 63,
        delegatedPublicKeyCbor,
        issuedAt,
        expiresAt,
        delegationId: new Uint8Array(16).fill(0xab),
      },
      rootKeyPair,
    );

    const verified = await verifyDelegationCertificateEs256(
      certificate,
      rootKeyPair.publicKey,
    );
    expect(verified).toBe(true);

    const info = parseDelegationCertificate(certificate);
    expect(info.logIdHex32).toBe(logIdHex32);
    expect(info.mmrStart).toBe(0);
    expect(info.mmrEnd).toBe(63);
    expect(info.issuedAt).toBe(issuedAt);
    expect(info.expiresAt).toBe(expiresAt);

    const cert = decode(certificate) as unknown[];
    const payloadMap = normalizeIntKeyedMap(decode(cert[2] as Uint8Array));
    const keyMap = normalizeIntKeyedMap(payloadMap.get(PAYLOAD_DELEGATED_KEY));
    expect(keyMap.get(COSE_KTY)).toBe(COSE_KTY_EC2);
    expect(keyMap.get(COSE_CRV)).toBe(COSE_CRV_P256);
    expect((keyMap.get(COSE_X) as Uint8Array).length).toBe(32);
    expect((keyMap.get(COSE_Y) as Uint8Array).length).toBe(32);
  });
});
