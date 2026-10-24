/**
 * Unit gate for the delegate-key voucher verifier (FOR-390 phase H, claim 4
 * from plan-2609-12 slice 07). Builds vouchers with the shared COSE_Sign1
 * signer and asserts verify accepts them and fails closed on a wrong
 * registrar key, any claim mismatch and an expired or (when required) missing
 * claim 4. The Go->TS byte-level cross-check is the shared protocol vector,
 * tested below.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodeCborDeterministic } from "./encode-cbor-deterministic.js";
import { signCoseSign1Statement } from "./sign-cose-sign1-statement.js";
import { bytesToHex, hexToBytes } from "./hex-test.js";
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
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", kp.publicKey),
  );
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
  notAfter?: unknown,
): Promise<Uint8Array> {
  const claims = new Map<number, unknown>([
    [1, sealerId],
    [2, epoch],
    [3, key],
  ]);
  if (notAfter !== undefined) claims.set(4, notAfter);
  const payload = encodeCborDeterministic(claims);
  return signCoseSign1Statement(payload, new Uint8Array([0xab]), priv, {
    alg: COSE_ALG_ES256,
  });
}

// Stand-in for the delegate key's canonical COSE_Key bytes; the verifier
// compares these bytes verbatim, it does not parse them as a key.
const delegKey = new Uint8Array([
  0xa5, 0x01, 0x02, 0x20, 0x01, 0x21, 0x58, 0x20,
]);

// A fixed verification instant (Unix seconds) and a claim 4 one day later.
const NOW = 1_800_000_000;
const NOT_AFTER = NOW + 86_400;

describe("verifyDelegateKeyVoucher", () => {
  it("accepts a well-formed voucher", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey);
    expect(
      await verifyDelegateKeyVoucher(
        v,
        pub,
        {
          sealerId: "sealer-a",
          epoch: 3,
          publicKey: delegKey,
        },
        NOW,
      ),
    ).toEqual({ ok: true });
  });

  it("fails closed on a wrong registrar key", async () => {
    const { priv } = await genRegistrarKey();
    const other = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey);
    expect(
      await verifyDelegateKeyVoucher(
        v,
        other.pub,
        {
          sealerId: "sealer-a",
          epoch: 3,
          publicKey: delegKey,
        },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "signature" });
  });

  it("fails closed on claim mismatches", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey);
    const sealer = await verifyDelegateKeyVoucher(
      v,
      pub,
      {
        sealerId: "sealer-b",
        epoch: 3,
        publicKey: delegKey,
      },
      NOW,
    );
    const epoch = await verifyDelegateKeyVoucher(
      v,
      pub,
      {
        sealerId: "sealer-a",
        epoch: 4,
        publicKey: delegKey,
      },
      NOW,
    );
    const key = await verifyDelegateKeyVoucher(
      v,
      pub,
      {
        sealerId: "sealer-a",
        epoch: 3,
        publicKey: new Uint8Array([0x09, 0x09]),
      },
      NOW,
    );
    expect(sealer).toEqual({ ok: false, reason: "sealerId" });
    expect(epoch).toEqual({ ok: false, reason: "epoch" });
    expect(key).toEqual({ ok: false, reason: "publicKey" });
  });

  it("returns claim 4 and accepts it before notAfter", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey, NOT_AFTER);
    const expectClaims = {
      sealerId: "sealer-a",
      epoch: 3,
      publicKey: delegKey,
    };
    expect(
      await verifyDelegateKeyVoucher(v, pub, expectClaims, NOT_AFTER - 1, {
        requireNotAfter: true,
      }),
    ).toEqual({ ok: true, notAfter: NOT_AFTER });
    expect(
      await verifyDelegateKeyVoucher(
        v,
        pub,
        { ...expectClaims, notAfter: NOT_AFTER },
        NOW,
      ),
    ).toEqual({ ok: true, notAfter: NOT_AFTER });
  });

  it("fails expired at and after notAfter, required or not", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey, NOT_AFTER);
    const expectClaims = {
      sealerId: "sealer-a",
      epoch: 3,
      publicKey: delegKey,
    };
    for (const requireNotAfter of [false, true]) {
      for (const now of [NOT_AFTER, NOT_AFTER + 1]) {
        expect(
          await verifyDelegateKeyVoucher(v, pub, expectClaims, now, {
            requireNotAfter,
          }),
        ).toEqual({ ok: false, reason: "expired" });
      }
    }
  });

  it("accepts a claim-4-less voucher unless requireNotAfter", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey);
    const expectClaims = {
      sealerId: "sealer-a",
      epoch: 3,
      publicKey: delegKey,
    };
    expect(await verifyDelegateKeyVoucher(v, pub, expectClaims, NOW)).toEqual({
      ok: true,
    });
    expect(
      await verifyDelegateKeyVoucher(v, pub, expectClaims, NOW, {
        requireNotAfter: true,
      }),
    ).toEqual({ ok: false, reason: "not_after_missing" });
  });

  it("fails closed on a notAfter mismatch or a malformed claim 4", async () => {
    const { priv, pub } = await genRegistrarKey();
    const expectClaims = {
      sealerId: "sealer-a",
      epoch: 3,
      publicKey: delegKey,
    };
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey, NOT_AFTER);
    expect(
      await verifyDelegateKeyVoucher(
        v,
        pub,
        { ...expectClaims, notAfter: NOT_AFTER + 1 },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "notAfter" });
    for (const bad of [-5, "1800086400", new Uint8Array([1])]) {
      const malformed = await makeVoucher(priv, "sealer-a", 3, delegKey, bad);
      expect(
        await verifyDelegateKeyVoucher(malformed, pub, expectClaims, NOW),
      ).toEqual({ ok: false, reason: "claims_shape" });
    }
  });

  it("treats an explicit claim 4 of 0 as present and expired", async () => {
    const { priv, pub } = await genRegistrarKey();
    const v = await makeVoucher(priv, "sealer-a", 3, delegKey, 0);
    const expectClaims = {
      sealerId: "sealer-a",
      epoch: 3,
      publicKey: delegKey,
    };
    for (const requireNotAfter of [false, true]) {
      expect(
        await verifyDelegateKeyVoucher(v, pub, expectClaims, NOW, {
          requireNotAfter,
        }),
      ).toEqual({ ok: false, reason: "expired" });
    }
  });

  it("refuses an unknown claim or a duplicated claim key", async () => {
    const { priv, pub } = await genRegistrarKey();
    const expectClaims = {
      sealerId: "sealer-a",
      epoch: 3,
      publicKey: delegKey,
    };
    const unknown = encodeCborDeterministic(
      new Map<number, unknown>([
        [1, "sealer-a"],
        [2, 3],
        [3, delegKey],
        [4, NOT_AFTER],
        [5, "extra"],
      ]),
    );
    const withUnknown = await signCoseSign1Statement(
      unknown,
      new Uint8Array([0xab]),
      priv,
      { alg: COSE_ALG_ES256 },
    );
    expect(
      await verifyDelegateKeyVoucher(withUnknown, pub, expectClaims, NOW),
    ).toEqual({ ok: false, reason: "claims_shape" });

    // {1: "sealer-a", 1: "sealer-a", 2: 3, 3: key}: claim 1 twice.
    const sealer = encodeCborDeterministic("sealer-a");
    const key = encodeCborDeterministic(delegKey);
    const dup = new Uint8Array([
      0xa4,
      0x01,
      ...sealer,
      0x01,
      ...sealer,
      0x02,
      0x03,
      0x03,
      ...key,
    ]);
    const withDup = await signCoseSign1Statement(
      dup,
      new Uint8Array([0xab]),
      priv,
      { alg: COSE_ALG_ES256 },
    );
    expect(
      await verifyDelegateKeyVoucher(withDup, pub, expectClaims, NOW),
    ).toEqual({ ok: false, reason: "claims_decode" });
  });

  it("parseRegistrarKeyXY requires 64 bytes", () => {
    expect(parseRegistrarKeyXY(new Uint8Array(63))).toBeNull();
    expect(parseRegistrarKeyXY(new Uint8Array(65))).toBeNull();
    expect(parseRegistrarKeyXY(new Uint8Array(64))).not.toBeNull();
  });
});

/**
 * The shared delegate-key voucher vector. Source of truth: forestrie/protocol
 * vectors/fixtures/delegate-key-voucher.json (format in vectors/README.md);
 * testdata/ holds a byte-identical copy pinned by SHA-256 below, and arbor
 * services/custodian/src/testdata/ holds the same bytes for the Go builder
 * that generated it. Do not edit the copy; change protocol and re-copy.
 */
const VOUCHER_VECTOR_SHA256 =
  "9dce83715cbdacb23c5f71e4e1fc63fb6e7c57b34ab84c80e80f601f1eb7b8c1";

interface VoucherVectorEntry {
  name: string;
  claims: {
    sealer_id: string;
    epoch: number;
    public_key_cose_hex: string;
    /** Omitted when the voucher has no claim 4. */
    not_after?: number;
  };
  payload_hex: string;
  voucher_hex: string;
  cases: {
    name: string;
    now: number;
    require_not_after: boolean;
    result: "ok" | "expired" | "not_after_missing";
  }[];
}

interface VoucherVector {
  registrar: { public_key_xy_hex: string };
  vouchers: VoucherVectorEntry[];
}

describe("delegate-key-voucher.json (shared Go/TypeScript vector)", () => {
  const raw = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "testdata",
      "delegate-key-voucher.json",
    ),
    "utf8",
  );
  const v = JSON.parse(raw) as VoucherVector;
  const registrar = parseRegistrarKeyXY(
    hexToBytes(v.registrar.public_key_xy_hex),
  )!;

  it("the vendored copy matches the pinned SHA-256", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      VOUCHER_VECTOR_SHA256,
    );
  });

  it("covers claim 4 set, absent and explicitly 0", () => {
    expect(v.vouchers.map((e) => e.claims.not_after ?? "absent")).toEqual([
      v.vouchers[0]!.claims.not_after,
      "absent",
      0,
    ]);
  });

  for (const e of v.vouchers) {
    const expectClaims = {
      sealerId: e.claims.sealer_id,
      epoch: e.claims.epoch,
      publicKey: hexToBytes(e.claims.public_key_cose_hex),
    };

    it(`${e.name}: the claims re-encode to the signed payload`, () => {
      const claims = new Map<number, unknown>([
        [1, expectClaims.sealerId],
        [2, expectClaims.epoch],
        [3, expectClaims.publicKey],
      ]);
      if (e.claims.not_after !== undefined) claims.set(4, e.claims.not_after);
      expect(bytesToHex(encodeCborDeterministic(claims))).toBe(e.payload_hex);
    });

    for (const c of e.cases) {
      it(`${e.name}: ${c.name}`, async () => {
        const got = await verifyDelegateKeyVoucher(
          hexToBytes(e.voucher_hex),
          registrar,
          expectClaims,
          c.now,
          { requireNotAfter: c.require_not_after },
        );
        expect(got).toEqual(
          c.result !== "ok"
            ? { ok: false, reason: c.result }
            : e.claims.not_after === undefined
              ? { ok: true }
              : { ok: true, notAfter: e.claims.not_after },
        );
      });
    }
  }
});
