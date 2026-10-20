/**
 * The checkpoint-chain trust root (FOR-368 Phase 3; owner ruling D8): fold a
 * retained `.sth` chain under the caller's roots with per-link delegation
 * limits ({@link makeCheckpointLinkVerifier}), match the receipt's peak
 * against ANY authenticated link, then judge certificate expiry on the
 * links covering the now-bound leaf ({@link checkCheckpointLinkExpiry}).
 * Lifted from mcp-verify 0.6.1's `verifyAtCheckpointChain`; forestrie-cli,
 * which matches peaks its own way, can use the pieces instead.
 *
 * Later links' signed consistency proofs commit an earlier accumulator
 * forward, so burial never turns an honest receipt tamper-shaped. Retention
 * limits coverage, never validity: a receipt newer than the chain fails
 * closed with a refresh remedy.
 *
 * Pure over bytes; no network (canopy rule C1).
 */
import { calculateRoot, peakMMRIndexes } from "@forestrie/merklelog";
import {
  verifyCheckpointChain,
  type CheckpointChainLink,
} from "./checkpoint-chain.js";
import type { CheckpointChainReceiptOutcome } from "./checkpoint-chain-receipt-outcome.js";
import {
  checkCheckpointLinkExpiry,
  makeCheckpointLinkVerifier,
} from "./checkpoint-link-verifier.js";
import { decodeChainBindingFromGenesis } from "./decode-chain-binding-from-genesis.js";
import type { Ks256Attestation } from "./ks256-attestation.js";
import { summarizeKs256AttestationUsage } from "./ks256-attestation-usage.js";
import { inclusionWalkEndIndex } from "./inclusion-walk-end.js";
import { univocityLeafHash } from "./leaf-commitment.js";
import { parseReceipt } from "./parse-receipt.js";
import type { RootVerifyKey } from "./root-verify-key.js";
import { SubtleHasher } from "./subtle-hasher.js";

/** Input to {@link verifyReceiptAgainstCheckpointChain}. */
export type VerifyReceiptAgainstCheckpointChainInput = {
  receiptCbor: Uint8Array;
  /** The leaf's idtimestamp; the last 8 bytes are used (big-endian). */
  idtimestampBe8: Uint8Array;
  /** Leaf ContentHash: SHA-256(payload), or the grant commitment hash. */
  inner: Uint8Array;
  /** Retained checkpoints in fold (ascending size) order. */
  checkpoints: readonly Uint8Array[];
  /** ES256 keys and KS256 addresses, from genesis or caller-known keys. */
  rootKeys: readonly RootVerifyKey[];
  /** ERC-1271 attestations, one per contract-root certificate. */
  attestations?: readonly Ks256Attestation[] | undefined;
  /**
   * The forest genesis, read only for its chain id (attestations must
   * match it). Give this or {@link forestChainId}; both must agree.
   */
  forestGenesisCbor?: Uint8Array | undefined;
  forestChainId?: bigint | undefined;
  /** Trusted base for a suffix chain; see `verifyCheckpointChain`. */
  trustedBase?: { size: bigint; accumulator: Uint8Array[] } | undefined;
};

/**
 * Verify a receipt against a retained checkpoint chain.
 *
 * The receipt's own signature is not checked: the authenticated chain is
 * the authority, and the peak is ALWAYS recomputed from the leaf
 * (`idtimestamp ‖ inner`) and the inclusion path, never taken from an
 * attached payload. A match binds the leaf's idtimestamp (through the leaf
 * hash) and its mmrIndex (through the matched peak's POSITION, which must be
 * the node the inclusion walk reaches: the leaf hash alone does not commit
 * its position, and an empty path commits none).
 * Links are searched newest first; the newest cover is reported.
 */
export async function verifyReceiptAgainstCheckpointChain(
  input: VerifyReceiptAgainstCheckpointChainInput,
): Promise<CheckpointChainReceiptOutcome> {
  const attestations = input.attestations ?? [];
  const empty = {
    links: [] as CheckpointChainLink[],
    records: [],
    attestations: summarizeKs256AttestationUsage(attestations, []),
  };
  if (input.rootKeys.length === 0) {
    return { ...empty, ok: false, stage: "input", reason: "no_trust_key" };
  }
  let forestChainId = input.forestChainId;
  if (input.forestGenesisCbor !== undefined) {
    let fromGenesis: bigint;
    try {
      fromGenesis = BigInt(
        decodeChainBindingFromGenesis(input.forestGenesisCbor).chainId,
      );
    } catch {
      return {
        ...empty,
        ok: false,
        stage: "input",
        reason: "forest_genesis_invalid",
      };
    }
    if (forestChainId !== undefined && forestChainId !== fromGenesis) {
      return {
        ...empty,
        ok: false,
        stage: "input",
        reason: "forest_chain_id_mismatch",
      };
    }
    forestChainId = fromGenesis;
  }

  const verifier = makeCheckpointLinkVerifier({
    rootKeys: input.rootKeys,
    attestations,
    forestChainId,
  });
  const chain = await verifyCheckpointChain({
    checkpoints: [...input.checkpoints],
    verifySignature: verifier.verifySignature,
    ...(input.trustedBase !== undefined
      ? { trustedBase: input.trustedBase }
      : {}),
  });
  const linkFailure = verifier.failure();
  const common = {
    links: chain.links,
    records: verifier.records,
    attestations: summarizeKs256AttestationUsage(
      attestations,
      verifier.records,
      linkFailure,
    ),
  };
  if (!chain.ok) {
    return {
      ...common,
      ok: false,
      stage: "chain",
      reason: linkFailure?.reason ?? `checkpoint_chain_${chain.reason}`,
      at: chain.at,
      detail: chain.detail,
      ...(linkFailure !== undefined ? { linkFailure } : {}),
    };
  }

  let parsed: ReturnType<typeof parseReceipt>;
  try {
    parsed = parseReceipt(input.receiptCbor);
  } catch {
    return {
      ...common,
      ok: false,
      stage: "parse",
      reason: "receipt_malformed",
    };
  }
  if (input.idtimestampBe8.length < 8) {
    return {
      ...common,
      ok: false,
      stage: "parse",
      reason: "idtimestamp_invalid",
    };
  }
  const idtimestamp = readU64Be(input.idtimestampBe8.slice(-8));
  // parseReceipt always sets mmrIndex; leafIndex wins when present, as in
  // every other peak recompute in this package.
  const leafMmrIndex = parsed.proof.leafIndex ?? parsed.proof.mmrIndex;
  if (leafMmrIndex === undefined) {
    return {
      ...common,
      ok: false,
      stage: "parse",
      reason: "receipt_malformed",
    };
  }

  const links = chain.links;
  const final = links[links.length - 1]!;
  if (leafMmrIndex >= final.treeSize2) {
    return {
      ...common,
      ok: false,
      stage: "anchor",
      reason: "receipt_newer_than_checkpoint_chain",
    };
  }

  let peak: Uint8Array;
  try {
    peak = await calculateRoot(
      new SubtleHasher(),
      await univocityLeafHash(idtimestamp, input.inner),
      parsed.proof,
      leafMmrIndex,
    );
  } catch {
    return {
      ...common,
      ok: false,
      stage: "parse",
      reason: "receipt_malformed",
    };
  }

  // The peak the path claims to reach. A leaf hash does not commit its
  // position (and an empty path commits none), so a value match alone would
  // leave mmrIndex a caller claim: the matched peak must sit at this index.
  const peakIndex = inclusionWalkEndIndex(
    leafMmrIndex,
    parsed.proof.path.length,
  );
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i]!;
    const p =
      link.treeSize2 > 0n
        ? peakMMRIndexes(link.treeSize2 - 1n).indexOf(peakIndex)
        : -1;
    if (p < 0 || !bytesEqual(link.accumulator[p] ?? new Uint8Array(), peak)) {
      continue;
    }
    // The leaf hash, inclusion path and peak position now bind idtimestamp
    // and mmrIndex to an authenticated accumulator, so expiry can be judged
    // on them.
    const expiry = checkCheckpointLinkExpiry(verifier.records, {
      mmrIndex: leafMmrIndex,
      idtimestamp,
    });
    if (!expiry.ok) {
      return {
        ...common,
        ok: false,
        stage: "delegation",
        reason: expiry.reason,
        at: expiry.at,
      };
    }
    return { ...common, ok: true, matchedLink: i, matchedPeak: p };
  }
  return {
    ...common,
    ok: false,
    stage: "anchor",
    reason: "peak_not_in_checkpoint_chain",
  };
}

function readU64Be(be8: Uint8Array): bigint {
  let v = 0n;
  for (const b of be8) v = (v << 8n) | BigInt(b);
  return v;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}
