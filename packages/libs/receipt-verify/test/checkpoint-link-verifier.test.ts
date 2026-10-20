/**
 * The checkpoint-chain trust root (receipt-verify 3.2.0, owner ruling D8):
 * per-link delegation limits (mmrStart/mmrEnd from the signed size, expiry
 * after the receipt matched), KS256 roots, and several ERC-1271
 * attestations. Ported from mcp-verify 0.6.1
 * `test/core/checkpoint-chain-constraints.test.ts`; everything is
 * generated at run time.
 */
import { describe, expect, it } from "vitest";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import {
  checkCheckpointLinkSizeBound,
  importEs256PublicKeyFromGrantDataXy64,
  ks256RootFromAddress,
  selectKs256Attestation,
  verifyReceiptAgainstCheckpointChain,
  verifyReceiptOfflineWithKeys,
  type CheckpointChainReceiptOutcome,
  type Ks256Attestation,
  type RootVerifyKey,
} from "../src/index.js";
import {
  attestationFor,
  buildChainFixture,
  buildEs256Cert,
  buildKs256Cert,
  coveringLink,
  ks256Genesis,
  leafUnixSeconds,
  newEs256Root,
  newKs256Signer,
  newSealer,
  twoLinks,
  wideLimits,
  CHAIN_FIXTURE_CHAIN_ID,
  type ChainFixture,
  type Es256Root,
} from "./helpers/checkpoint-chain-links-fixture.js";

const PAYLOAD = new TextEncoder().encode("a chain-rooted statement");

async function setup(): Promise<{
  fx: ChainFixture;
  sealer: CryptoKeyPair;
  root: Es256Root;
  rootKey: CryptoKey;
}> {
  const inner = new Uint8Array(await crypto.subtle.digest("SHA-256", PAYLOAD));
  const sealer = await newSealer();
  const fx = await buildChainFixture(inner, sealer);
  const root = await newEs256Root();
  const rootKey = await importEs256PublicKeyFromGrantDataXy64(root.keyXy);
  return { fx, sealer, root, rootKey };
}

function run(
  fx: ChainFixture,
  checkpoints: Uint8Array[],
  rootKeys: RootVerifyKey[],
  extra: {
    attestations?: Ks256Attestation[];
    forestGenesisCbor?: Uint8Array;
    forestChainId?: bigint;
    idtimestampBe8?: Uint8Array;
  } = {},
): Promise<CheckpointChainReceiptOutcome> {
  return verifyReceiptAgainstCheckpointChain({
    receiptCbor: fx.receipt,
    idtimestampBe8: extra.idtimestampBe8 ?? fx.idtimestampBe8,
    inner: fx.inner,
    checkpoints,
    rootKeys,
    attestations: extra.attestations,
    forestGenesisCbor: extra.forestGenesisCbor,
    forestChainId: extra.forestChainId,
  });
}

function fail(o: CheckpointChainReceiptOutcome) {
  if (o.ok) throw new Error("expected a failing outcome");
  return o;
}

describe("checkpoint-chain: delegation limits per link (ES256 root)", () => {
  it("passes a certificate whose limits contain the link and the leaf", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, wideLimits(fx));
    const o = await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.matchedLink).toBe(0);
    expect(o.matchedPeak).toBe(0);
    expect(o.records).toHaveLength(1);
    expect(o.records[0]).toMatchObject({
      index: 0,
      signedSize: 3n,
      verifiedBy: "delegated",
      attestationNeeded: false,
    });
    expect(o.records[0]!.constraints?.mmrEnd).toBe(65535n);
  });

  it("passes a certificate carrying no limits at all", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, {});
    const o = await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]);
    expect(o.ok).toBe(true);
    expect(o.records[0]!.constraints).toBeNull();
  });

  it("a partial limit set (label 4 only) is treated as no limits", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, { mmrEnd: 0n });
    const o = await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]);
    expect(o.ok).toBe(true);
  });

  it("a root-signed link without a certificate is verified by the ES256 root", async () => {
    const { fx, root, rootKey } = await setup();
    const o = await run(
      fx,
      [await coveringLink(fx, root.pair, null)],
      [rootKey],
    );
    expect(o.ok).toBe(true);
    expect(o.records[0]).toMatchObject({
      verifiedBy: "es256-root",
      constraints: null,
    });
  });

  it("rejects a link whose signed size runs past mmrEnd", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    // size 3 -> mmrIndex 2 > mmrEnd 1, although the leaf (index 1) is inside.
    const cert = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      mmrEnd: 1n,
    });
    const o = fail(
      await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]),
    );
    expect(o.stage).toBe("chain");
    expect(o.reason).toBe("delegation_out_of_range");
    expect(o.at).toBe(0);
    expect(o.linkFailure).toEqual({
      index: 0,
      reason: "delegation_out_of_range",
    });
  });

  it("the mmrEnd bound is exact: mmrEnd == size-1 passes", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      mmrEnd: 2n,
    });
    const o = await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]);
    expect(o.ok).toBe(true);
  });

  it("rejects a link whose signed size-1 is below mmrStart (D8)", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    // size 3 -> mmrIndex 2 < mmrStart 3: univocity reverts, so must we.
    const cert = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      mmrStart: 3n,
    });
    const o = fail(
      await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]),
    );
    expect(o.stage).toBe("chain");
    expect(o.reason).toBe("delegation_out_of_range");
    expect(o.at).toBe(0);
  });

  it("the mmrStart bound is exact: mmrStart == size-1 passes", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      mmrStart: 2n,
    });
    const o = await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]);
    expect(o.ok).toBe(true);
  });

  it("mmrStart binds a non-covering link too", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const late = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      mmrStart: 1n,
    });
    const live = await buildEs256Cert(root, sealer, wideLimits(fx));
    // Link 0 signs size 1 -> mmrIndex 0 < mmrStart 1.
    const o = fail(
      await run(
        fx,
        await twoLinks(fx, { sealer, cert: late }, { sealer, cert: live }),
        [rootKey],
      ),
    );
    expect(o.reason).toBe("delegation_out_of_range");
    expect(o.at).toBe(0);
    // The same cert on the size-3 link is inside its window.
    const ok = await run(
      fx,
      await twoLinks(fx, { sealer, cert: live }, { sealer, cert: late }),
      [rootKey],
    );
    expect(ok.ok).toBe(true);
  });

  it("the mmrEnd bound applies to a non-covering link too", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const tight = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      mmrEnd: 0n,
    });
    const live = await buildEs256Cert(root, sealer, wideLimits(fx));
    const ok = await run(
      fx,
      await twoLinks(fx, { sealer, cert: tight }, { sealer, cert: live }),
      [rootKey],
    );
    expect(ok.ok).toBe(true);
    const bad = fail(
      await run(
        fx,
        await twoLinks(fx, { sealer, cert: live }, { sealer, cert: tight }),
        [rootKey],
      ),
    );
    expect(bad.reason).toBe("delegation_out_of_range");
    expect(bad.at).toBe(1);
  });

  it("size 0 maps to mmrIndex 0, as univocity's claimedSize > 0 ? size-1 : 0", () => {
    const c = (mmrStart: bigint, mmrEnd: bigint) => ({
      mmrStart,
      mmrEnd,
      issuedAt: 0,
      expiresAt: 0,
    });
    expect(checkCheckpointLinkSizeBound(c(0n, 0n), 0n)).toEqual({ ok: true });
    expect(checkCheckpointLinkSizeBound(c(1n, 5n), 0n)).toEqual({
      ok: false,
      reason: "delegation_out_of_range",
    });
    // size 1 is also mmrIndex 0: the same verdicts.
    expect(checkCheckpointLinkSizeBound(c(0n, 0n), 1n)).toEqual({ ok: true });
    expect(checkCheckpointLinkSizeBound(c(1n, 5n), 1n).ok).toBe(false);
    expect(checkCheckpointLinkSizeBound(c(0n, 0n), 2n).ok).toBe(false);
  });

  it("rejects a covering link whose cert expired before the leaf was sequenced", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      expiresAt: leafUnixSeconds(fx) - 10,
    });
    const o = fail(
      await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey]),
    );
    expect(o.stage).toBe("delegation");
    expect(o.reason).toBe("delegation_expired");
    expect(o.at).toBe(0);
  });

  it("a link that does not cover the leaf is not held to the leaf's time", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const expired = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      expiresAt: leafUnixSeconds(fx) - 10,
    });
    const live = await buildEs256Cert(root, sealer, wideLimits(fx));
    const o = await run(
      fx,
      await twoLinks(fx, { sealer, cert: expired }, { sealer, cert: live }),
      [rootKey],
    );
    expect(o.ok).toBe(true);
    expect(o.links).toHaveLength(2);
  });

  it("the covering link of the same chain still fails when ITS cert is expired", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const expired = await buildEs256Cert(root, sealer, {
      ...wideLimits(fx),
      expiresAt: leafUnixSeconds(fx) - 10,
    });
    const live = await buildEs256Cert(root, sealer, wideLimits(fx));
    const o = fail(
      await run(
        fx,
        await twoLinks(fx, { sealer, cert: live }, { sealer, cert: expired }),
        [rootKey],
      ),
    );
    expect(o.stage).toBe("delegation");
    expect(o.at).toBe(1);
  });

  it("a forged idtimestamp cannot turn an honest chain into a delegation violation", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    // Live for the REAL leaf time, expired for a far-future one.
    const cert = await buildEs256Cert(root, sealer, wideLimits(fx));
    const o = fail(
      await run(fx, [await coveringLink(fx, sealer, cert)], [rootKey], {
        idtimestampBe8: new Uint8Array(8).fill(0xff),
      }),
    );
    expect(o.stage).toBe("anchor");
    expect(o.reason).toBe("peak_not_in_checkpoint_chain");
  });

  it("a receipt newer than the chain fails closed with the refresh reason", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const live = await buildEs256Cert(root, sealer, wideLimits(fx));
    const [first] = await twoLinks(
      fx,
      { sealer, cert: live },
      { sealer, cert: live },
    );
    const o = fail(await run(fx, [first!], [rootKey]));
    expect(o.stage).toBe("anchor");
    expect(o.reason).toBe("receipt_newer_than_checkpoint_chain");
  });

  it("a link signed by an unrelated key fails as a signature, not a limit", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, wideLimits(fx));
    const o = fail(
      await run(
        fx,
        [await coveringLink(fx, await newSealer(), cert)],
        [rootKey],
      ),
    );
    expect(o.stage).toBe("chain");
    expect(o.reason).toBe("signature_invalid");
  });

  it("refuses to run without a root key", async () => {
    const { fx } = await setup();
    const o = fail(await run(fx, [], []));
    expect(o.stage).toBe("input");
    expect(o.reason).toBe("no_trust_key");
  });
});

describe("checkpoint-chain: KS256 roots and several attestations (D8)", () => {
  async function ks256Setup() {
    const { fx, sealer } = await setup();
    return { fx, sealer, limits: wideLimits(fx) };
  }

  it("an EOA root verifies by ecrecover; a supplied attestation is not needed", async () => {
    const { fx, sealer, limits } = await ks256Setup();
    const eoa = newKs256Signer();
    const c = await buildKs256Cert({
      rootAddress: eoa.address,
      signer: eoa,
      sealer,
      limits,
    });
    const att = attestationFor(eoa.address, c);
    const o = await run(
      fx,
      [await coveringLink(fx, sealer, c.cert)],
      [ks256RootFromAddress(eoa.address)],
      { attestations: [att], forestGenesisCbor: ks256Genesis(eoa.address) },
    );
    expect(o.ok).toBe(true);
    expect(o.records[0]).toMatchObject({
      verifiedBy: "ks256-root",
      attestationNeeded: false,
      attestationIndex: 0,
    });
    expect(o.records[0]!.attestationUsed).toBeUndefined();
    expect(o.attestations.used).toEqual([]);
    expect(o.attestations.unused).toEqual([
      { index: 0, digestHex: hex(c.digest), reason: "not_needed" },
    ]);
  });

  it("an EOA root still enforces the KS256 cert's limits", async () => {
    const { fx, sealer, limits } = await ks256Setup();
    const eoa = newKs256Signer();
    const c = await buildKs256Cert({
      rootAddress: eoa.address,
      signer: eoa,
      sealer,
      limits: { ...limits, mmrStart: 5n },
    });
    const o = fail(
      await run(
        fx,
        [await coveringLink(fx, sealer, c.cert)],
        [ks256RootFromAddress(eoa.address)],
      ),
    );
    expect(o.reason).toBe("delegation_out_of_range");
  });

  /** A Safe that rotated its delegate: one cert (and attestation) each. */
  async function safeRotation() {
    const { fx, limits } = await ks256Setup();
    const safe = crypto.getRandomValues(new Uint8Array(20));
    const sealerA = await newSealer();
    const sealerB = await newSealer();
    const certA = await buildKs256Cert({
      rootAddress: safe,
      signer: newKs256Signer(),
      sealer: sealerA,
      limits,
    });
    const certB = await buildKs256Cert({
      rootAddress: safe,
      signer: newKs256Signer(),
      sealer: sealerB,
      limits,
    });
    const checkpoints = await twoLinks(
      fx,
      { sealer: sealerA, cert: certA.cert },
      { sealer: sealerB, cert: certB.cert },
    );
    return {
      fx,
      safe,
      certA,
      certB,
      checkpoints,
      attA: attestationFor(safe, certA),
      attB: attestationFor(safe, certB),
      rootKeys: [ks256RootFromAddress(safe)],
      genesis: ks256Genesis(safe),
    };
  }

  it("a Safe chain with two certs passes with both attestations, in any order", async () => {
    const s = await safeRotation();
    const o = await run(s.fx, s.checkpoints, s.rootKeys, {
      attestations: [s.attB, s.attA],
      forestGenesisCbor: s.genesis,
    });
    expect(o.ok).toBe(true);
    expect(o.records.map((r) => r.attestationIndex)).toEqual([1, 0]);
    expect(o.records.map((r) => r.attestationNeeded)).toEqual([true, true]);
    expect(o.records.map((r) => r.verifiedBy)).toEqual([
      "ks256-root",
      "ks256-root",
    ]);
    expect(o.records[0]!.attestationUsed).toBe(hex(s.certA.digest));
    expect(o.records[1]!.attestationUsed).toBe(hex(s.certB.digest));
    expect(o.attestations.used).toEqual([
      { index: 0, digestHex: hex(s.certB.digest), links: [1] },
      { index: 1, digestHex: hex(s.certA.digest), links: [0] },
    ]);
    expect(o.attestations.unused).toEqual([]);
  });

  it("with only the first cert's attestation, the second cert's link fails", async () => {
    const s = await safeRotation();
    const o = fail(
      await run(s.fx, s.checkpoints, s.rootKeys, {
        attestations: [s.attA],
        forestGenesisCbor: s.genesis,
      }),
    );
    expect(o.stage).toBe("chain");
    expect(o.at).toBe(1);
    // The one attestation reaches link 1 only to name the mismatch.
    expect(o.reason).toBe("ks256_attestation_digest_mismatch");
    expect(o.attestations.used).toEqual([
      { index: 0, digestHex: hex(s.certA.digest), links: [0] },
    ]);
  });

  it("without any attestation the first link fails ks256_root_not_recovered", async () => {
    const s = await safeRotation();
    const o = fail(
      await run(s.fx, s.checkpoints, s.rootKeys, {
        forestGenesisCbor: s.genesis,
      }),
    );
    expect(o.at).toBe(0);
    expect(o.reason).toBe("ks256_root_not_recovered");
  });

  it("an attestation matching no certificate is reported, never ignored", async () => {
    const s = await safeRotation();
    const stray = attestationFor(s.safe, {
      cert: new Uint8Array(),
      digest: new Uint8Array(32).fill(7),
      signatureHash: new Uint8Array(32).fill(8),
    });
    const o = await run(s.fx, s.checkpoints, s.rootKeys, {
      attestations: [s.attA, stray, s.attB],
      forestChainId: CHAIN_FIXTURE_CHAIN_ID,
    });
    expect(o.ok).toBe(true);
    expect(o.attestations.used.map((u) => u.index)).toEqual([0, 2]);
    expect(o.attestations.unused).toEqual([
      {
        index: 1,
        digestHex: "07".repeat(32),
        reason: "no_matching_certificate",
      },
    ]);
  });

  it("an attestation for another chain is rejected and reported as such", async () => {
    const s = await safeRotation();
    const o = fail(
      await run(s.fx, s.checkpoints, s.rootKeys, {
        attestations: [
          attestationFor(s.safe, s.certA, { chainId: 1n }),
          s.attB,
        ],
        forestGenesisCbor: s.genesis,
      }),
    );
    expect(o.at).toBe(0);
    expect(o.reason).toBe("ks256_attestation_chain_mismatch");
    expect(o.attestations.unused).toEqual([
      { index: 0, digestHex: hex(s.certA.digest), reason: "rejected" },
      {
        index: 1,
        digestHex: hex(s.certB.digest),
        reason: "no_matching_certificate",
      },
    ]);
  });

  it("an attestation without the forest chain id cannot be bound", async () => {
    const s = await safeRotation();
    const o = fail(
      await run(s.fx, s.checkpoints, s.rootKeys, {
        attestations: [s.attA, s.attB],
      }),
    );
    expect(o.reason).toBe("ks256_attestation_chain_unbound");
  });

  it("a forest chain id that disagrees with the genesis is an input error", async () => {
    const s = await safeRotation();
    const o = fail(
      await run(s.fx, s.checkpoints, s.rootKeys, {
        attestations: [s.attA, s.attB],
        forestGenesisCbor: s.genesis,
        forestChainId: 1n,
      }),
    );
    expect(o.stage).toBe("input");
    expect(o.reason).toBe("forest_chain_id_mismatch");
  });

  it("selectKs256Attestation needs the digest AND the signature hash", async () => {
    const s = await safeRotation();
    const cert = {
      address: s.safe,
      digest: s.certA.digest,
      signature: new Uint8Array(65),
    };
    // Right digest, wrong signature hash: not this certificate's attestation.
    expect(selectKs256Attestation(cert, [s.attA])).toBeUndefined();
  });
});

describe("an attached peak must be the one the inclusion proof recomputes", () => {
  /** The fixture receipt with its peak attached instead of detached. The
   * Sig_structure is the same bytes either way, so the signature holds. */
  function attach(fx: ChainFixture): Uint8Array {
    const [p, u, , sig] = decodeCborDeterministic(fx.receipt) as unknown[];
    return encodeCborDeterministic([p, u, fx.peak, sig]);
  }

  it("checkpoint chain: an honest attached peak matches", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, wideLimits(fx));
    const o = await run(
      { ...fx, receipt: attach(fx) },
      [await coveringLink(fx, sealer, cert)],
      [rootKey],
    );
    expect(o.ok).toBe(true);
  });

  it("checkpoint chain: an anchored attached peak does not carry another payload", async () => {
    const { fx, sealer, root, rootKey } = await setup();
    const cert = await buildEs256Cert(root, sealer, wideLimits(fx));
    const o = fail(
      await run(
        { ...fx, receipt: attach(fx), inner: new Uint8Array(32).fill(0x11) },
        [await coveringLink(fx, sealer, cert)],
        [rootKey],
      ),
    );
    expect(o.stage).toBe("anchor");
    expect(o.reason).toBe("peak_not_in_checkpoint_chain");
  });

  it("signature path: a validly signed attached peak does not carry another payload", async () => {
    const { fx, sealer } = await setup();
    const honest = await verifyReceiptOfflineWithKeys({
      receiptCbor: attach(fx),
      payload: PAYLOAD,
      idtimestampBe8: fx.idtimestampBe8,
      trustKeys: [sealer.publicKey],
    });
    expect(honest).toEqual({ ok: true, stage: "binding" });
    const forged = await verifyReceiptOfflineWithKeys({
      receiptCbor: attach(fx),
      payload: new TextEncoder().encode("some other statement"),
      idtimestampBe8: fx.idtimestampBe8,
      trustKeys: [sealer.publicKey],
    });
    expect(forged).toEqual({
      ok: false,
      stage: "inclusion",
      reason: "inclusion_failed",
    });
  });
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
