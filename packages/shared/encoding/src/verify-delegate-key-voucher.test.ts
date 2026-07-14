/**
 * Unit gate for the delegate-key voucher verifier (FOR-390 phase H). Builds a
 * voucher with the shared COSE_Sign1 signer and asserts verify accepts it and
 * fails closed on a wrong registrar key or any claim mismatch. The Go->TS
 * byte-level cross-check (custodian-signed voucher verifies here) is a Phase I
 * / e2e gate; this covers the verify logic and claim comparison.
 */
import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { signCoseSign1Statement } from "./sign-cose-sign1-statement.js";
import { COSE_ALG_ES256, type ParsedEcPublicKey } from "./verify-cose-sign1.js";
import {
  parseRegistrarKeyXY,
  verifyDelegateKeyVoucher,
} from "./verify-delegate-key-voucher.js";

async function genRegistrarKey(): Promise<{
  priv: CryptoKey;
  pub: ParsedEcPublicKey;
}> {
  const kp = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    priv: kp.privateKey,
    pub: { x: raw.slice(1, 33), y: raw.slice(33, 65), curve: "P-256" },
  };
}

async function makeVoucher(
  priv: CryptoKey,
  sealerId: string,
  epoch: number,
  key: Uint8Array,
): Promise<Uint8Array> {
  const payload = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, sealerId],
      [2, epoch],
      [3, key],
    ]),
  );
  return signCoseSign1Statement(payload, new Uint8Array([0xab]), priv, {
    alg: COSE_ALG_ES256,
  });
}

// Stand-in for the delegate key's canonical COSE_Key bytes; the verifier
// compares these bytes verbatim, it does not parse them as a key.
const delegKey = new Uint8Array([0xa5, 0x01, 0x02, 0x20, 0x01, 0x21, 0x58, 0x20]);

describe("verifyDelegateKeyVoucher", () => {
  it("accepts a well-formed voucher", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey);
    expect(
      await verifyDelegateKeyVoucher(v, pub, {
        sealerId: "sealer-a",
        epoch: 3,
        publicKey: delegKey,
      }),
    ).toEqual({ ok: true });
  });

  it("fails closed on a wrong registrar key", async () => {
    const { priv } = await genRegistrarKey();
    const other = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey);
    expect(
      await verifyDelegateKeyVoucher(v, other.pub, {
        sealerId: "sealer-a",
        epoch: 3,
        publicKey: delegKey,
      }),
    ).toEqual({ ok: false, reason: "signature" });
  });

  it("fails closed on claim mismatches", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey);
    const sealer = await verifyDelegateKeyVoucher(v, pub, {
      sealerId: "sealer-b",
      epoch: 3,
      publicKey: delegKey,
    });
    const epoch = await verifyDelegateKeyVoucher(v, pub, {
      sealerId: "sealer-a",
      epoch: 4,
      publicKey: delegKey,
    });
    const key = await verifyDelegateKeyVoucher(v, pub, {
      sealerId: "sealer-a",
      epoch: 3,
      publicKey: new Uint8Array([0x09, 0x09]),
    });
    expect(sealer).toEqual({ ok: false, reason: "sealerId" });
    expect(epoch).toEqual({ ok: false, reason: "epoch" });
    expect(key).toEqual({ ok: false, reason: "publicKey" });
  });

  it("parseRegistrarKeyXY requires 64 bytes", () => {
    expect(parseRegistrarKeyXY(new Uint8Array(63))).toBeNull();
    expect(parseRegistrarKeyXY(new Uint8Array(65))).toBeNull();
    expect(parseRegistrarKeyXY(new Uint8Array(64))).not.toBeNull();
  });
});
