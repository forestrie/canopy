/**
 * Golden-vector: BYOK delegation cert payload field 5 uses integer COSE_Key keys.
 */

import { decode, Encoder } from "cbor-x";
import { describe, expect, it } from "vitest";
import {
  buildByokDelegationMaterial,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
} from "./coordinator-delegation-helpers.js";
import { normalizeForestrieHexId32 } from "./forestrie-hex-id.js";

const cborEncoder = new Encoder({ mapsAsObjects: false });

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

    const reencoded = cborEncoder.encode(keyMap);
    const roundTrip = decode(reencoded) as Record<number, unknown>;
    const kty =
      roundTrip instanceof Map
        ? roundTrip.get(1)
        : (roundTrip[1] ?? roundTrip["1"]);
    expect(kty).toBe(2);
  });
});
