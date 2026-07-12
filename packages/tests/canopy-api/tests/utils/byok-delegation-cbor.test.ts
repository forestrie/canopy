/**
 * Golden-vector: BYOK delegation cert payload field 5 uses integer COSE_Key keys.
 */

import {
  decodeCborDeterministic as decode,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  buildByokDelegationMaterial,
  buildKs256BootstrapDelegationMaterial,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
} from "./coordinator-delegation-helpers.js";
import { assertGoCompatibleDelegatedKeyInCertificate } from "./delegation-cbor-contract.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";

describe("BYOK delegation CBOR contract", () => {
  it("embeds integer-key delegated COSE_Key in certificate payload", async () => {
    const logUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const logHex32 = normalizeForestrieHexId32(logUuid);
    const rootKeyPair = await generateEs256RootKeyPair();
    const delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();
    const material = await buildByokDelegationMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 63,
      delegatedPublicKey,
    });

    const cert = decode(material.certificate) as unknown[];
    const payloadBytes = cert[2] as Uint8Array;
    const payloadRaw = decode(payloadBytes) as unknown;
    const payload =
      payloadRaw instanceof Map
        ? payloadRaw
        : new Map(
            Object.entries(payloadRaw as Record<string, unknown>).map(
              ([k, v]) => [Number(k), v] as const,
            ),
          );
    const delegatedRaw = payload.get(5);
    const keyMap =
      delegatedRaw instanceof Map
        ? delegatedRaw
        : new Map(
            Object.entries(delegatedRaw as Record<string, unknown>).map(
              ([k, v]) => [Number(k), v] as const,
            ),
          );
    expect(keyMap.get(1)).toBe(2);
    expect(keyMap.get(-1)).toBe(1);
    expect(keyMap.get(-2)).toBeInstanceOf(Uint8Array);
    expect(keyMap.get(-3)).toBeInstanceOf(Uint8Array);

    const reencoded = encodeCborDeterministic(keyMap);
    const roundTrip = decode(reencoded) as Record<number, unknown>;
    const kty =
      roundTrip instanceof Map
        ? roundTrip.get(1)
        : (roundTrip[1] ?? roundTrip["1"]);
    expect(kty).toBe(2);
  });

  it("passes Go-compatible field-5 check for ES256 bootstrap material", async () => {
    const logUuid = "b2c3d4e5-f6a7-8901-bcde-f12345678901";
    const logHex32 = normalizeForestrieHexId32(logUuid);
    const rootKeyPair = await generateEs256RootKeyPair();
    const delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();
    const material = await buildByokDelegationMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 63,
      delegatedPublicKey,
    });
    expect(() =>
      assertGoCompatibleDelegatedKeyInCertificate(material.certificate),
    ).not.toThrow();
  });

  it("passes Go-compatible field-5 check for KS256 bootstrap material", async () => {
    const logUuid = "c3d4e5f6-a7b8-9012-cdef-123456789012";
    const logHex32 = normalizeForestrieHexId32(logUuid);
    const privateKeyHex =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const rootAddress = new Uint8Array([
      0x7b, 0x0e, 0x80, 0x9c, 0x6a, 0x7e, 0x3b, 0x16, 0x3c, 0x4d, 0x3a, 0x2b,
      0xb1, 0xc0, 0x7c, 0x6d, 0x3e, 0x8f, 0x1a, 0x2b,
    ]);
    const delegatedPublicKey = await generateEphemeralDelegatedPublicKeyCbor();
    const material = await buildKs256BootstrapDelegationMaterial({
      rootSignerAddress: rootAddress,
      privateKeyHex,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 127,
      delegatedPublicKey,
    });
    expect(() =>
      assertGoCompatibleDelegatedKeyInCertificate(material.certificate),
    ).not.toThrow();
  });
});
