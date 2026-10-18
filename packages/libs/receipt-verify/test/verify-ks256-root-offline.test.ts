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
  verifyGrantReceiptOffline,
  verifyGrantReceiptOfflineWithKeys,
  type Ks256Attestation,
} from "../src/index.js";
import {
  KS256_FIXTURE_CHAIN_ID,
  buildKs256DelegatedReceiptFixture,
} from "./helpers/ks256-delegated-receipt-fixture.js";

function attestationFor(
  address: Uint8Array,
  digest: Uint8Array,
  overrides: Partial<Ks256Attestation> = {},
): Ks256Attestation {
  return {
    version: 1,
    chainId: KS256_FIXTURE_CHAIN_ID,
    address,
    digest,
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
      encodeKs256Attestation(attestationFor(fx.rootAddress, fx.certDigest)),
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
        chainId: { chainId: 1n },
        magic: { magic: new Uint8Array(4) },
      }[field];
      const result = await verifyGrantReceiptOffline({
        ...fx,
        ks256Attestation: attestationFor(fx.rootAddress, fx.certDigest, wrong),
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
    const ks256Attestation = attestationFor(fx.rootAddress, fx.certDigest);
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
