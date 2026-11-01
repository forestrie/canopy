/**
 * Delegation MMR range (payload labels 3/4) is a uint64 end to end: build
 * encodes CBOR major type 0 up to 2^64-1, parse returns it as `bigint`
 * without rounding, and a label that is present but not a uint64 is a hard
 * reject (plan-2611-01 S1, FOR-613).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  COSE_CRV,
  COSE_CRV_P256,
  COSE_KTY,
  COSE_KTY_EC2,
  COSE_X,
  COSE_Y,
  buildDelegationCertificateEs256,
  encodeIntKeyCbor,
  parseDelegationCertificate,
  type DelegationInput,
} from "../src/index.js";

const UINT64_MAX = (1n << 64n) - 1n;
const LOG_ID_HEX32 = "a1b2c3d4e5f67890abcdef1234567890";

async function newKeyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function delegatedKeyCbor(): Promise<Uint8Array> {
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", (await newKeyPair()).publicKey),
  );
  return encodeIntKeyCbor(
    new Map<number, unknown>([
      [COSE_KTY, COSE_KTY_EC2],
      [COSE_CRV, COSE_CRV_P256],
      [COSE_X, raw.slice(1, 33)],
      [COSE_Y, raw.slice(33, 65)],
    ]),
  );
}

async function buildWithRange(
  mmrStart: bigint,
  mmrEnd: bigint,
): Promise<Uint8Array> {
  const input: DelegationInput = {
    logIdHex32: LOG_ID_HEX32,
    mmrStart,
    mmrEnd,
    delegatedPublicKeyCbor: await delegatedKeyCbor(),
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_003_600,
    delegationId: new Uint8Array(16).fill(0xab),
  };
  return buildDelegationCertificateEs256(input, await newKeyPair());
}

/**
 * A COSE_Sign1 certificate around a hand-built payload map. The signature
 * is junk: {@link parseDelegationCertificate} reads the payload only.
 */
function certificateWithPayload(payload: Uint8Array): Uint8Array {
  return encodeCborDeterministic([
    encodeCborDeterministic(new Map<number, unknown>([[1, -7]])),
    new Map<number, unknown>(),
    payload,
    new Uint8Array(64),
  ]);
}

/** A payload map with the given range labels (omitted when undefined). */
function payloadWith(range: {
  start?: unknown;
  end?: unknown;
}): Map<number, unknown> {
  const m = new Map<number, unknown>([[1, LOG_ID_HEX32]]);
  if (range.start !== undefined) m.set(3, range.start);
  if (range.end !== undefined) m.set(4, range.end);
  m.set(7, 1);
  m.set(8, 1_700_000_000);
  m.set(9, 1_700_003_600);
  m.set(10, new Uint8Array(16).fill(0xab));
  return m;
}

/**
 * Encode `payload` with label 4's value replaced by a CBOR float64 (`fb`) of
 * `value` — what cbor-x emitted for an integer above uint32. The sentinel
 * uint64 head (`1b` + 8 bytes) and the float64 head are both 9 bytes, so the
 * map stays well formed.
 */
function encodeWithFloatAtLabel4(
  payload: Map<number, unknown>,
  value: number,
): Uint8Array {
  const sentinel = 0x1122334455667788n;
  const bytes = encodeCborDeterministic(new Map(payload).set(4, sentinel));
  const head = [0x1b, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
  const at = bytes.findIndex((_, i) =>
    head.every((b, j) => bytes[i + j] === b),
  );
  if (at < 0) throw new Error("sentinel not found");
  const float = new Uint8Array(9);
  float[0] = 0xfb;
  new DataView(float.buffer).setFloat64(1, value, false);
  bytes.set(float, at);
  return bytes;
}

describe("parseDelegationCertificate mmr range", () => {
  it.each([
    ["2^32+1", (1n << 32n) + 1n],
    ["2^53+1", (1n << 53n) + 1n],
    ["2^64-1", UINT64_MAX],
  ])("round-trips mmrEnd = %s exactly", async (_name, mmrEnd) => {
    const info = parseDelegationCertificate(await buildWithRange(1n, mmrEnd));
    expect(info.mmrStart).toBe(1n);
    expect(info.mmrEnd).toBe(mmrEnd);
  });
});

describe("parseDelegationCertificate rejects a malformed mmr range", () => {
  it("rejects a CBOR float64 at label 4 (the cbor-x encoding of 2^32+1)", () => {
    const payload = encodeWithFloatAtLabel4(
      payloadWith({ start: 0, end: 0 }),
      2 ** 32 + 1,
    );
    expect(() =>
      parseDelegationCertificate(certificateWithPayload(payload)),
    ).toThrow(/mmrEnd \(label 4\) is not a uint64 \(got CborFloat\)/);
  });

  it("rejects a negative mmrStart", () => {
    const payload = encodeIntKeyCbor(payloadWith({ start: -1, end: 10 }));
    expect(() =>
      parseDelegationCertificate(certificateWithPayload(payload)),
    ).toThrow(/mmrStart \(label 3\) is not a uint64/);
  });

  it("rejects a text-string mmrEnd", () => {
    const payload = encodeIntKeyCbor(payloadWith({ start: 0, end: "10" }));
    expect(() =>
      parseDelegationCertificate(certificateWithPayload(payload)),
    ).toThrow(/mmrEnd \(label 4\) is not a uint64/);
  });

  it.each([
    ["mmrStart", { end: 10 }, /payload missing mmrStart \(label 3\)/],
    ["mmrEnd", { start: 0 }, /payload missing mmrEnd \(label 4\)/],
  ])("rejects a missing %s", (_name, range, message) => {
    const payload = encodeIntKeyCbor(payloadWith(range));
    expect(() =>
      parseDelegationCertificate(certificateWithPayload(payload)),
    ).toThrow(message);
  });

  it("rejects mmrStart > mmrEnd", () => {
    const payload = encodeIntKeyCbor(payloadWith({ start: 11, end: 10 }));
    expect(() =>
      parseDelegationCertificate(certificateWithPayload(payload)),
    ).toThrow(/mmrStart 11 > mmrEnd 10/);
  });

  it("accepts mmrStart == mmrEnd", () => {
    const payload = encodeIntKeyCbor(payloadWith({ start: 10, end: 10 }));
    const info = parseDelegationCertificate(certificateWithPayload(payload));
    expect(info.mmrStart).toBe(10n);
    expect(info.mmrEnd).toBe(10n);
  });
});

describe("delegation certificate build rejects an mmr range outside uint64", () => {
  it("rejects mmrEnd above 2^64-1", async () => {
    await expect(buildWithRange(0n, UINT64_MAX + 1n)).rejects.toThrow(
      /mmrEnd .* outside uint64/,
    );
  });

  it("rejects a negative mmrStart", async () => {
    await expect(buildWithRange(-1n, 10n)).rejects.toThrow(
      /mmrStart .* outside uint64/,
    );
  });

  it("rejects mmrStart > mmrEnd", async () => {
    await expect(buildWithRange(11n, 10n)).rejects.toThrow(
      /mmrStart 11 > mmrEnd 10/,
    );
  });
});
