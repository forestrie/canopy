import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";
import {
  calculateRoot,
  verifyInclusion,
  type Proof,
} from "@forestrie/merklelog";
import type { Grant } from "@forestrie/encoding";
import { grantCommitmentHashFromGrant } from "./grant-commitment.js";
import { decodeTrustRootFromGenesis } from "./decode-trust-root-from-genesis.js";
import { decodeChainBindingFromGenesis } from "./decode-chain-binding-from-genesis.js";
import type { Ks256Attestation } from "./ks256-attestation.js";
import { isParsedKs256RootKey, type RootVerifyKey } from "./root-verify-key.js";
import {
  checkDelegationConstraints,
  resolveDelegatedVerifyKey,
} from "./resolve-delegated-verify-key.js";
import { univocityLeafHash } from "./leaf-commitment.js";
import { parseReceipt } from "./parse-receipt.js";
import type { ReceiptVerifyResult } from "./receipt-verify-result.js";
import { SubtleHasher } from "./subtle-hasher.js";
import { resolveWithKs256Attestations } from "./select-ks256-attestation.js";

export type VerifyGrantReceiptOfflineInput = {
  genesisCbor: Uint8Array;
  receiptCbor: Uint8Array;
  grant: Grant;
  idtimestampBe8: Uint8Array;
  /** See {@link VerifyReceiptOfflineInput.ks256Attestation}. */
  ks256Attestation?: Ks256Attestation;
  /** See {@link VerifyReceiptOfflineInput.ks256Attestations}. */
  ks256Attestations?: readonly Ks256Attestation[];
};

function readIdtimestampBe8(bytes: Uint8Array): bigint {
  if (!bytes || bytes.length < 8) {
    throw new Error("idtimestamp required for receipt verification (8 bytes)");
  }
  const view =
    bytes.length === 8
      ? new DataView(bytes.buffer, bytes.byteOffset, 8)
      : new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 8);
  return view.getBigUint64(0, false);
}

async function verifySignatureAndInclusion(opts: {
  receiptCbor: Uint8Array;
  explicitPeak: Uint8Array | null;
  proof: Proof;
  leafHash: Uint8Array;
  verifyKeys: CryptoKey[];
}): Promise<ReceiptVerifyResult> {
  const hasher = new SubtleHasher();
  const leafIdx =
    opts.proof.leafIndex !== undefined
      ? opts.proof.leafIndex
      : opts.proof.mmrIndex!;
  const peak =
    opts.explicitPeak !== null
      ? opts.explicitPeak
      : await calculateRoot(hasher, opts.leafHash, opts.proof, leafIdx);

  let sigOk = false;
  for (const candidateKey of opts.verifyKeys) {
    sigOk = await verifyCoseSign1WithParsedKey(opts.receiptCbor, candidateKey, {
      logPrefix: "grant-receipt-offline",
      detachedPayload: peak,
    });
    if (sigOk) break;
    if (opts.explicitPeak !== null) {
      sigOk = await verifyCoseSign1WithParsedKey(
        opts.receiptCbor,
        candidateKey,
        { logPrefix: "grant-receipt-offline" },
      );
      if (sigOk) break;
    }
  }

  if (!sigOk) {
    if (opts.explicitPeak !== null) {
      const inclusionOk = await verifyInclusion(
        hasher,
        opts.leafHash,
        opts.proof,
        opts.explicitPeak,
      );
      return {
        ok: false,
        stage: "signature",
        reason: inclusionOk ? "signature_invalid" : "signature_invalid",
      };
    }
    return { ok: false, stage: "signature", reason: "signature_invalid" };
  }

  const inclusionOk = await verifyInclusion(
    hasher,
    opts.leafHash,
    opts.proof,
    peak,
  );
  if (!inclusionOk) {
    return { ok: false, stage: "inclusion", reason: "inclusion_failed" };
  }
  return { ok: true, stage: "binding" };
}

/**
 * Offline grant receipt verify (layers A–C, ADR-0045). Pure over bytes; no network.
 */
export async function verifyGrantReceiptOffline(
  input: VerifyGrantReceiptOfflineInput,
): Promise<ReceiptVerifyResult> {
  // A GRANT leaf commits the grant commitment hash (register-grant / create-log).
  let inner: Uint8Array;
  try {
    inner = await grantCommitmentHashFromGrant(input.grant);
  } catch {
    return { ok: false, stage: "binding", reason: "grant_invalid" };
  }
  return verifyReceiptOfflineWithLeafInner({
    genesisCbor: input.genesisCbor,
    receiptCbor: input.receiptCbor,
    idtimestampBe8: input.idtimestampBe8,
    inner,
    ks256Attestations: attestationCandidates(input),
  });
}

export type VerifyGrantReceiptOfflineWithKeysInput = Omit<
  VerifyGrantReceiptOfflineInput,
  "genesisCbor"
> &
  Pick<VerifyReceiptOfflineWithKeysInput, "trustKeys" | "forestGenesisCbor">;

/**
 * {@link verifyGrantReceiptOffline} under caller-supplied trust keys instead of
 * the genesis trust root — see {@link verifyReceiptOfflineWithKeys} for the
 * trust model this buys (and what it does not).
 */
export async function verifyGrantReceiptOfflineWithKeys(
  input: VerifyGrantReceiptOfflineWithKeysInput,
): Promise<ReceiptVerifyResult> {
  let inner: Uint8Array;
  try {
    inner = await grantCommitmentHashFromGrant(input.grant);
  } catch {
    return { ok: false, stage: "binding", reason: "grant_invalid" };
  }
  return verifyReceiptOfflineWithLeafInnerKeys({
    receiptCbor: input.receiptCbor,
    idtimestampBe8: input.idtimestampBe8,
    inner,
    trustKeys: input.trustKeys,
    ks256Attestations: attestationCandidates(input),
    forestChainId: input.forestGenesisCbor
      ? genesisChainIdOrUndefined(input.forestGenesisCbor)
      : undefined,
  });
}

export type VerifyReceiptOfflineInput = {
  genesisCbor: Uint8Array;
  receiptCbor: Uint8Array;
  /**
   * The EXACT registered payload bytes whose SHA-256 is the leaf ContentHash.
   * Kind-agnostic: for a SCITT signed statement this is the statement COSE
   * bytes; for a forestrie grant leaf it is the grant commitment preimage
   * (see {@link verifyGrantReceiptOffline}, which derives it).
   */
  payload: Uint8Array;
  idtimestampBe8: Uint8Array;
  /**
   * ERC-1271 attestation for a KS256 contract root (plan-2610-03 D4). Used
   * only when ecrecover doesn't match the root, and accepted only when it
   * binds the root address, the certificate digest and the genesis chain id.
   */
  ks256Attestation?: Ks256Attestation;
  /**
   * Several attestations (owner ruling D8): the one whose digest and
   * signature hash match the receipt's certificate is used
   * ({@link selectKs256Attestation}). Combined with
   * {@link ks256Attestation} when both are given. When none matches, one
   * still reaches the KS256 check only to name the mismatch: it can never
   * verify the certificate.
   */
  ks256Attestations?: readonly Ks256Attestation[];
};

/**
 * Offline verify of a receipt against the EXACT registered payload. The log
 * leaf commits `SHA-256(idtimestamp ‖ SHA-256(payload))`; this is the standard,
 * COSE-Receipts-conformant path (a SCITT statement receipt is exactly this with
 * `payload` = the signed statement). Genesis trust root, FOR-297 delegation
 * resolution, inclusion, and signature are all standard.
 */
export async function verifyReceiptOffline(
  input: VerifyReceiptOfflineInput,
): Promise<ReceiptVerifyResult> {
  const inner = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      input.payload as unknown as BufferSource,
    ),
  );
  return verifyReceiptOfflineWithLeafInner({
    genesisCbor: input.genesisCbor,
    receiptCbor: input.receiptCbor,
    idtimestampBe8: input.idtimestampBe8,
    inner,
    ks256Attestations: attestationCandidates(input),
  });
}

export type VerifyReceiptOfflineWithKeysInput = Omit<
  VerifyReceiptOfflineInput,
  "genesisCbor"
> & {
  /**
   * Caller-known trust keys, tried in order: ES256 `CryptoKey`s or KS256
   * 20-byte addresses ({@link knownLogKeyFromBytes}). For a child-log receipt
   * this is the log OWNER's key (the delegation-cert issuer), NOT the sealer
   * key — the label-1000 cert is verified under these keys and the delegated
   * sealer key is extracted from it, so the anchor survives sealer rotation.
   */
  trustKeys: RootVerifyKey[];
  /**
   * The forest's genesis, read only for the chain id a `ks256Attestation`
   * must match (D6); it supplies no trust keys. Without it an attestation is
   * refused with `ks256_attestation_chain_unbound`.
   */
  forestGenesisCbor?: Uint8Array;
};

/**
 * {@link verifyReceiptOffline} under caller-supplied trust keys instead of the
 * genesis trust root (FOR-297 "known log key"). Standard SCITT relying-party
 * posture: the caller obtained the log owner's key out of band and trusts it.
 *
 * Trust ladder — what this rung gives up relative to its neighbours:
 * - Known log key (this entry): fully offline, but the "key K owns log L"
 *   binding is ASSERTED by the caller's key provenance, not proven; no grant
 *   lifecycle/expiry visibility; no split-view protection.
 * - Grant-chain walk (approach A, open): derives the binding from
 *   `genesis.cbor` + public tiles and adds lifecycle visibility.
 * - Chain-anchored (live or cached accumulator): adds split-view protection —
 *   the contract-enforced on-chain accumulator is the strongest anchor.
 *
 * Do NOT fetch the trust key from the log operator's API or tile store — that
 * silently reintroduces the operator trust this entry exists to remove.
 */
export async function verifyReceiptOfflineWithKeys(
  input: VerifyReceiptOfflineWithKeysInput,
): Promise<ReceiptVerifyResult> {
  const inner = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      input.payload as unknown as BufferSource,
    ),
  );
  return verifyReceiptOfflineWithLeafInnerKeys({
    receiptCbor: input.receiptCbor,
    idtimestampBe8: input.idtimestampBe8,
    inner,
    trustKeys: input.trustKeys,
    ks256Attestations: attestationCandidates(input),
    forestChainId: input.forestGenesisCbor
      ? genesisChainIdOrUndefined(input.forestGenesisCbor)
      : undefined,
  });
}

/**
 * Every attestation the caller supplied: the list, then the singular field
 * (kept for 3.1.0 callers).
 */
function attestationCandidates(input: {
  ks256Attestation?: Ks256Attestation | undefined;
  ks256Attestations?: readonly Ks256Attestation[] | undefined;
}): Ks256Attestation[] {
  return [
    ...(input.ks256Attestations ?? []),
    ...(input.ks256Attestation ? [input.ks256Attestation] : []),
  ];
}

/**
 * The forest's chain id from its genesis chain binding, or `undefined` when
 * the genesis carries none (an attestation then can't be bound, D6).
 */
function genesisChainIdOrUndefined(
  genesisCbor: Uint8Array,
): bigint | undefined {
  try {
    return BigInt(decodeChainBindingFromGenesis(genesisCbor).chainId);
  } catch {
    return undefined;
  }
}

/**
 * Shared offline-verify core: reconstruct the leaf as
 * `univocityLeafHash(idtimestamp, inner)`, resolve the (possibly delegated,
 * FOR-297) verify key from the genesis trust root, and check signature +
 * inclusion. `inner` is the leaf ContentHash = `SHA-256(payload)` — the grant
 * commitment for a grant leaf, or `SHA-256(statement)` for a statement leaf.
 */
async function verifyReceiptOfflineWithLeafInner(input: {
  genesisCbor: Uint8Array;
  receiptCbor: Uint8Array;
  idtimestampBe8: Uint8Array;
  inner: Uint8Array;
  ks256Attestations: Ks256Attestation[];
}): Promise<ReceiptVerifyResult> {
  let trustRoot: RootVerifyKey;
  try {
    trustRoot = await decodeTrustRootFromGenesis(input.genesisCbor);
  } catch {
    return { ok: false, stage: "parse", reason: "genesis_invalid" };
  }

  return verifyReceiptOfflineWithLeafInnerKeys({
    receiptCbor: input.receiptCbor,
    idtimestampBe8: input.idtimestampBe8,
    inner: input.inner,
    trustKeys: [trustRoot],
    ks256Attestations: input.ks256Attestations,
    forestChainId: genesisChainIdOrUndefined(input.genesisCbor),
  });
}

/**
 * Trust-key-parameterised offline-verify core. Identical to the genesis path
 * once the trust keys are in hand: resolve the (possibly delegated, FOR-297)
 * verify key against `trustKeys`, then check signature + inclusion. Receipts
 * are always ES256, so a KS256 trust key only ever verifies the delegation
 * certificate; only ES256 trust keys are tried on the receipt itself.
 */
async function verifyReceiptOfflineWithLeafInnerKeys(input: {
  receiptCbor: Uint8Array;
  idtimestampBe8: Uint8Array;
  inner: Uint8Array;
  trustKeys: RootVerifyKey[];
  ks256Attestations: Ks256Attestation[];
  /** The forest genesis chain id an attestation must carry, if known. */
  forestChainId: bigint | undefined;
}): Promise<ReceiptVerifyResult> {
  let parsed: ReturnType<typeof parseReceipt>;
  try {
    parsed = parseReceipt(input.receiptCbor);
  } catch {
    return { ok: false, stage: "parse", reason: "receipt_malformed" };
  }

  if (!input.trustKeys.length) {
    return { ok: false, stage: "signature", reason: "no_es256_trust_key" };
  }

  // FOR-297: when the receipt was signed by a DELEGATED key, verify the
  // label-1000 delegation certificate under the trust keys and try the
  // delegated key first. A cert present but not chaining to a trust key is a
  // hard failure — do not silently fall back to the trust key (which cannot
  // verify a delegated-signed receipt anyway).
  // D8: the attestations made for THIS receipt's certificate (digest and
  // signature hash), tried in order; none matching, a stand-in only names
  // the mismatch.
  const { resolution: delegation } = await resolveWithKs256Attestations(
    input.receiptCbor,
    input.trustKeys,
    input.ks256Attestations,
    input.forestChainId,
  );
  if (delegation.kind === "broken") {
    return {
      ok: false,
      stage: "signature",
      reason: delegation.reason ?? "delegation_invalid",
    };
  }
  const es256TrustKeys = input.trustKeys.filter(
    (k): k is CryptoKey => !isParsedKs256RootKey(k),
  );
  if (delegation.kind === "root-only" && !es256TrustKeys.length) {
    // A KS256 root never signs a receipt; without a certificate there is no
    // ES256 key to check it with.
    return {
      ok: false,
      stage: "signature",
      reason: "ks256_root_requires_delegation",
    };
  }
  const allVerifyKeys =
    delegation.kind === "resolved"
      ? [delegation.delegatedKey, ...es256TrustKeys]
      : es256TrustKeys;

  let idtimestamp: bigint;
  try {
    idtimestamp = readIdtimestampBe8(input.idtimestampBe8);
  } catch {
    return { ok: false, stage: "binding", reason: "idtimestamp_invalid" };
  }

  // FOR-420: a resolved delegation cert authorizes its key only within an MMR
  // coverage window and validity window. Enforce both before reporting the
  // signature/inclusion as ok — a delegated key signing outside its authorized
  // range, or after its expiry-at-issuance, fails at stage `signature`.
  if (delegation.kind === "resolved" && delegation.constraints) {
    const leafMmrIndex = parsed.proof.mmrIndex ?? parsed.proof.leafIndex ?? 0n;
    const check = checkDelegationConstraints(
      delegation.constraints,
      leafMmrIndex,
      idtimestamp,
    );
    if (!check.ok) {
      return { ok: false, stage: "signature", reason: check.reason };
    }
  }

  const leafHash = await univocityLeafHash(idtimestamp, input.inner);

  return verifySignatureAndInclusion({
    receiptCbor: input.receiptCbor,
    explicitPeak: parsed.explicitPeak,
    proof: parsed.proof,
    leafHash,
    verifyKeys: allVerifyKeys,
  });
}
