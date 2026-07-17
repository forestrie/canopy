import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";
import {
  calculateRoot,
  verifyInclusion,
  type Proof,
} from "@forestrie/merklelog";
import type { Grant } from "@forestrie/encoding";
import { grantCommitmentHashFromGrant } from "./grant-commitment.js";
import { decodeTrustRootFromGenesis } from "./decode-trust-root-from-genesis.js";
import { es256ReceiptVerifyKeys } from "./decode-trust-root-cbor.js";
import { resolveDelegatedVerifyKey } from "./resolve-delegated-verify-key.js";
import { univocityLeafHash } from "./leaf-commitment.js";
import { parseReceipt } from "./parse-receipt.js";
import type { ReceiptVerifyResult } from "./receipt-verify-result.js";
import { SubtleHasher } from "./subtle-hasher.js";

export type VerifyGrantReceiptOfflineInput = {
  genesisCbor: Uint8Array;
  receiptCbor: Uint8Array;
  grant: Grant;
  idtimestampBe8: Uint8Array;
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
  });
}

export type VerifyGrantReceiptOfflineWithKeysInput = Omit<
  VerifyGrantReceiptOfflineInput,
  "genesisCbor"
> & {
  /** Caller-known ES256 trust keys — see {@link VerifyReceiptOfflineWithKeysInput}. */
  trustKeys: CryptoKey[];
};

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
  });
}

export type VerifyReceiptOfflineWithKeysInput = Omit<
  VerifyReceiptOfflineInput,
  "genesisCbor"
> & {
  /**
   * Caller-known ES256 trust keys, tried in order. For a child-log receipt
   * this is the log OWNER's key (the delegation-cert issuer), NOT the sealer
   * key — the label-1000 cert is verified under these keys and the delegated
   * sealer key is extracted from it, so the anchor survives sealer rotation.
   */
  trustKeys: CryptoKey[];
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
  });
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
}): Promise<ReceiptVerifyResult> {
  let trustRoot;
  try {
    trustRoot = await decodeTrustRootFromGenesis(input.genesisCbor);
  } catch {
    return { ok: false, stage: "parse", reason: "genesis_invalid" };
  }

  const verifyKeys = es256ReceiptVerifyKeys([trustRoot]) as CryptoKey[];
  if (!verifyKeys.length) {
    return { ok: false, stage: "signature", reason: "no_es256_trust_key" };
  }

  return verifyReceiptOfflineWithLeafInnerKeys({
    receiptCbor: input.receiptCbor,
    idtimestampBe8: input.idtimestampBe8,
    inner: input.inner,
    trustKeys: verifyKeys,
  });
}

/**
 * Trust-key-parameterised offline-verify core. Identical to the genesis path
 * once the trust keys are in hand: resolve the (possibly delegated, FOR-297)
 * verify key against `trustKeys`, then check signature + inclusion.
 */
async function verifyReceiptOfflineWithLeafInnerKeys(input: {
  receiptCbor: Uint8Array;
  idtimestampBe8: Uint8Array;
  inner: Uint8Array;
  trustKeys: CryptoKey[];
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
  const delegation = await resolveDelegatedVerifyKey(
    input.receiptCbor,
    input.trustKeys,
  );
  if (delegation.kind === "broken") {
    return { ok: false, stage: "signature", reason: "delegation_invalid" };
  }
  const allVerifyKeys =
    delegation.kind === "resolved"
      ? [delegation.delegatedKey, ...input.trustKeys]
      : input.trustKeys;

  let idtimestamp: bigint;
  try {
    idtimestamp = readIdtimestampBe8(input.idtimestampBe8);
  } catch {
    return { ok: false, stage: "binding", reason: "idtimestamp_invalid" };
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
