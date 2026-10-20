/**
 * plan-2610-03 slice 03 (D4–D7): receipts under a KS256 root verify offline.
 * EOA roots by ecrecover; contract roots only with an ERC-1271 attestation
 * bound to the root address, the certificate digest and the genesis chain;
 * a 20-byte known log key; alg confusion refused.
 */

import { describe, expect, it } from "vitest";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import {
  ERC1271_MAGIC_VALUE,
  decodeKs256Attestation,
  encodeKs256Attestation,
  extractKs256DelegationDigest,
  knownLogKeyFromBytes,
  ks256RootFromAddress,
  verifyGrantReceiptOffline,
  verifyGrantReceiptOfflineWithKeys,
  type Ks256Attestation,
} from "../src/index.js";
import {
  KS256_FIXTURE_CHAIN_ID,
  buildKs256DelegatedReceiptFixture,
} from "./helpers/ks256-delegated-receipt-fixture.js";
import { generateP256KeyPair } from "./helpers/grant-receipt-fixture.js";

function attestationFor(
  address: Uint8Array,
  digest: Uint8Array,
  signatureHash: Uint8Array,
  overrides: Partial<Ks256Attestation> = {},
): Ks256Attestation {
  return {
    version: 1,
    chainId: KS256_FIXTURE_CHAIN_ID,
    address,
    digest,
    signatureHash,
    blockNumber: 1234n,
    blockHash: new Uint8Array(32).fill(0x0b),
    magic: ERC1271_MAGIC_VALUE,
    ...overrides,
  };
}

describe("KS256 genesis root, offline", () => {
  it("verifies an EOA-rooted receipt by ecrecover", async () => {
    const fx = await buildKs256DelegatedReceiptFixture();
    const result = await verifyGrantReceiptOffline(fx);
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("returns ks256_root_not_recovered when ecrecover doesn't match", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ wrongSigner: true });
    const result = await verifyGrantReceiptOffline(fx);
    expect(result).toEqual({
      ok: false,
      stage: "signature",
      reason: "ks256_root_not_recovered",
    });
  });

  it("refuses alg confusion although ecrecover would match", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ algConfusion: true });
    const result = await verifyGrantReceiptOffline(fx);
    expect(result).toEqual({
      ok: false,
      stage: "signature",
      reason: "delegation_not_ks256",
    });
  });

  it("refuses a KS256 root with no delegation certificate", async () => {
    const fx = await buildKs256DelegatedReceiptFixture();
    // Re-encode the receipt without its label-1000 certificate.
    const [p, u, payload, sig] = decodeCborDeterministic(
      fx.receiptCbor,
    ) as unknown[];
    (u as Map<number, unknown>).delete(1000);
    const receiptCbor = encodeCborDeterministic([p, u, payload, sig]);
    const result = await verifyGrantReceiptOffline({ ...fx, receiptCbor });
    expect(result).toEqual({
      ok: false,
      stage: "signature",
      reason: "ks256_root_requires_delegation",
    });
  });
});

describe("KS256 contract root, ERC-1271 attestation", () => {
  it("is not recovered without an attestation", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const result = await verifyGrantReceiptOffline(fx);
    expect(result.reason).toBe("ks256_root_not_recovered");
  });

  it("verifies with an attestation bound to address, digest and chain", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const attestation = decodeKs256Attestation(
      encodeKs256Attestation(
        attestationFor(fx.rootAddress, fx.certDigest, fx.certSignatureHash),
      ),
    );
    const result = await verifyGrantReceiptOffline({
      ...fx,
      ks256Attestation: attestation,
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it.each([
    ["address", "ks256_attestation_address_mismatch"],
    ["digest", "ks256_attestation_digest_mismatch"],
    ["signatureHash", "ks256_attestation_signature_mismatch"],
    ["chainId", "ks256_attestation_chain_mismatch"],
    ["magic", "ks256_attestation_magic_invalid"],
  ] as const)(
    "rejects an attestation with another %s",
    async (field, reason) => {
      const fx = await buildKs256DelegatedReceiptFixture({
        contractRoot: true,
      });
      const wrong: Partial<Ks256Attestation> = {
        address: { address: new Uint8Array(20).fill(0x77) },
        digest: { digest: new Uint8Array(32).fill(0x77) },
        signatureHash: { signatureHash: new Uint8Array(32).fill(0x77) },
        chainId: { chainId: 1n },
        magic: { magic: new Uint8Array(4) },
      }[field];
      const result = await verifyGrantReceiptOffline({
        ...fx,
        ks256Attestation: attestationFor(
          fx.rootAddress,
          fx.certDigest,
          fx.certSignatureHash,
          wrong,
        ),
      });
      expect(result).toEqual({ ok: false, stage: "signature", reason });
    },
  );

  it("extracts the address, digest and signature an attestation is made over", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const parts = extractKs256DelegationDigest(fx.receiptCbor);
    expect(parts?.address).toEqual(fx.rootAddress);
    expect(parts?.digest).toEqual(fx.certDigest);
    expect(parts?.signature.length).toBe(65);
  });
});

describe("KS256 known log key", () => {
  it("accepts a 20-byte known log key (EOA)", async () => {
    const fx = await buildKs256DelegatedReceiptFixture();
    const result = await verifyGrantReceiptOfflineWithKeys({
      ...fx,
      trustKeys: [await knownLogKeyFromBytes(fx.rootAddress)],
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("refuses an attestation without the forest genesis for its chain", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const trustKeys = [await knownLogKeyFromBytes(fx.rootAddress)];
    const ks256Attestation = attestationFor(
      fx.rootAddress,
      fx.certDigest,
      fx.certSignatureHash,
    );
    const unbound = await verifyGrantReceiptOfflineWithKeys({
      ...fx,
      trustKeys,
      ks256Attestation,
    });
    expect(unbound.reason).toBe("ks256_attestation_chain_unbound");
    const bound = await verifyGrantReceiptOfflineWithKeys({
      ...fx,
      trustKeys,
      ks256Attestation,
      forestGenesisCbor: fx.genesisCbor,
    });
    expect(bound).toEqual({ ok: true, stage: "binding" });
  });

  it("refuses known log key bytes that are neither 64 nor 20 bytes", async () => {
    await expect(knownLogKeyFromBytes(new Uint8Array(33))).rejects.toThrow(
      /64 bytes .* or 20 bytes/,
    );
  });
});

describe("KS256 roots: constraints, mixed keys and strictness", () => {
  it("enforces FOR-420 expiry on a KS256-rooted certificate", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({
      expiredAtIssuance: true,
    });
    const result = await verifyGrantReceiptOffline(fx);
    expect(result).toEqual({
      ok: false,
      stage: "signature",
      reason: "delegation_expired",
    });
  });

  it("refuses an attestation when the genesis carries no chain id", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({
      contractRoot: true,
      omitGenesisChainId: true,
    });
    const result = await verifyGrantReceiptOffline({
      ...fx,
      ks256Attestation: attestationFor(
        fx.rootAddress,
        fx.certDigest,
        fx.certSignatureHash,
      ),
    });
    expect(result.reason).toBe("ks256_attestation_chain_unbound");
  });

  it("refuses a KS256 certificate under an ES256 trust key", async () => {
    const fx = await buildKs256DelegatedReceiptFixture();
    const result = await verifyGrantReceiptOfflineWithKeys({
      ...fx,
      trustKeys: [await randomEs256Key()],
    });
    expect(result.reason).toBe("delegation_invalid");
  });

  it("accepts a KS256 root among mixed ES256 and KS256 trust keys", async () => {
    const fx = await buildKs256DelegatedReceiptFixture();
    const result = await verifyGrantReceiptOfflineWithKeys({
      ...fx,
      trustKeys: [
        await randomEs256Key(),
        await knownLogKeyFromBytes(new Uint8Array(20).fill(0x55)),
        await knownLogKeyFromBytes(fx.rootAddress),
      ],
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("refuses a KS256 root address that is not 20 bytes", () => {
    expect(() => ks256RootFromAddress(new Uint8Array(32))).toThrow(/20 bytes/);
  });

  it("decodes attestations strictly", () => {
    const good = attestationFor(
      new Uint8Array(20).fill(1),
      new Uint8Array(32).fill(2),
      new Uint8Array(32).fill(3),
    );
    const encoded = encodeKs256Attestation(good);
    expect(decodeKs256Attestation(encoded)).toEqual(good);
    const asMap = decodeCborDeterministic(encoded) as Map<number, unknown>;
    const variant = (edit: (m: Map<number, unknown>) => void) => {
      const m = new Map(asMap);
      edit(m);
      return encodeCborDeterministic(m);
    };
    expect(() => decodeKs256Attestation(variant((m) => m.set(9, 1)))).toThrow(
      /unknown label/,
    );
    expect(() => decodeKs256Attestation(variant((m) => m.set(1, 2)))).toThrow(
      /version/,
    );
    expect(() =>
      decodeKs256Attestation(variant((m) => m.set(3, new Uint8Array(19)))),
    ).toThrow(/address/);
    expect(() =>
      decodeKs256Attestation(variant((m) => m.set(7, new Uint8Array(5)))),
    ).toThrow(/magic/);
    expect(() =>
      decodeKs256Attestation(variant((m) => m.set(2, "84532"))),
    ).toThrow(/chainId/);
    expect(() => decodeKs256Attestation(variant((m) => m.delete(4)))).toThrow(
      /digest/,
    );
    expect(() =>
      decodeKs256Attestation(variant((m) => m.set(8, new Uint8Array(31)))),
    ).toThrow(/signatureHash/);
  });
});

async function randomEs256Key(): Promise<CryptoKey> {
  const pair = await generateP256KeyPair();
  const raw = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return (await knownLogKeyFromBytes(raw.slice(1))) as CryptoKey;
}

describe("KS256 contract root, several attestations (D8)", () => {
  const decoy = (address: Uint8Array) =>
    attestationFor(
      address,
      new Uint8Array(32).fill(0x55),
      new Uint8Array(32).fill(0x66),
    );

  it("picks the attestation matching the receipt's certificate from a list", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const right = attestationFor(
      fx.rootAddress,
      fx.certDigest,
      fx.certSignatureHash,
    );
    const result = await verifyGrantReceiptOffline({
      ...fx,
      ks256Attestations: [decoy(fx.rootAddress), right],
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("combines the list with the singular field", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const result = await verifyGrantReceiptOffline({
      ...fx,
      ks256Attestations: [decoy(fx.rootAddress)],
      ks256Attestation: attestationFor(
        fx.rootAddress,
        fx.certDigest,
        fx.certSignatureHash,
      ),
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });

  it("a list with no matching attestation fails, naming the mismatch", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const result = await verifyGrantReceiptOffline({
      ...fx,
      ks256Attestations: [decoy(fx.rootAddress), decoy(fx.rootAddress)],
    });
    expect(result).toEqual({
      ok: false,
      stage: "signature",
      reason: "ks256_attestation_digest_mismatch",
    });
  });

  it("picks from a list under a caller-known KS256 key too", async () => {
    const fx = await buildKs256DelegatedReceiptFixture({ contractRoot: true });
    const result = await verifyGrantReceiptOfflineWithKeys({
      receiptCbor: fx.receiptCbor,
      grant: fx.grant,
      idtimestampBe8: fx.idtimestampBe8,
      trustKeys: [await knownLogKeyFromBytes(fx.rootAddress)],
      forestGenesisCbor: fx.genesisCbor,
      ks256Attestations: [
        decoy(fx.rootAddress),
        attestationFor(fx.rootAddress, fx.certDigest, fx.certSignatureHash),
      ],
    });
    expect(result).toEqual({ ok: true, stage: "binding" });
  });
});
