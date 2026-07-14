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
  let parsed: ReturnType<typeof parseReceipt>;
  try {
    parsed = parseReceipt(input.receiptCbor);
  } catch {
    return { ok: false, stage: "parse", reason: "receipt_malformed" };
  }

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

  // FOR-297: when the receipt was signed by a DELEGATED key, verify the
  // label-1000 delegation certificate under the root and try the delegated key
  // first. A cert present but not chaining to the root is a hard failure — do
  // not silently fall back to the root key (which cannot verify a
  // delegated-signed receipt anyway).
  const delegation = await resolveDelegatedVerifyKey(
    input.receiptCbor,
    verifyKeys,
  );
  if (delegation.kind === "broken") {
    return { ok: false, stage: "signature", reason: "delegation_invalid" };
  }
  const allVerifyKeys =
    delegation.kind === "resolved"
      ? [delegation.delegatedKey, ...verifyKeys]
      : verifyKeys;

  let inner: Uint8Array;
  try {
    inner = await grantCommitmentHashFromGrant(input.grant);
  } catch {
    return { ok: false, stage: "binding", reason: "grant_invalid" };
  }

  let idtimestamp: bigint;
  try {
    idtimestamp = readIdtimestampBe8(input.idtimestampBe8);
  } catch {
    return { ok: false, stage: "binding", reason: "idtimestamp_invalid" };
  }

  const leafHash = await univocityLeafHash(idtimestamp, inner);

  return verifySignatureAndInclusion({
    receiptCbor: input.receiptCbor,
    explicitPeak: parsed.explicitPeak,
    proof: parsed.proof,
    leafHash,
    verifyKeys: allVerifyKeys,
  });
}
