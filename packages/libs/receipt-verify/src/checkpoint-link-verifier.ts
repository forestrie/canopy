/**
 * Per-link trust for a retained checkpoint chain: the `verifySignature`
 * callback {@link verifyCheckpointChain} takes, plus the delegation limits
 * each link's label-1000 certificate imposes. Lifted from mcp-verify 0.6.1
 * (`src/core/verify-shared.ts`) so mcp-verify and forestrie-cli share one
 * copy; see mcp-verify `docs/trust-roots.md` ("Delegation limits under
 * checkpoint-chain").
 *
 * The limits mirror univocity's on-chain check
 * ([delegationVerifier.sol](https://github.com/forestrie/univocity/blob/main/src/checkpoints/lib/delegationVerifier.sol)):
 * a checkpoint of claimed size `S` is anchored only when its delegation
 * covers `mmrIndex = S > 0 ? S - 1 : 0`, i.e. `mmrStart <= mmrIndex <=
 * mmrEnd`. Here `S` is the checkpoint's SIGNED tree size (label -65933), so
 * a link the contract would refuse is refused offline too
 * (`delegation_out_of_range`). Expiry needs a leaf the receipt binds and is
 * judged after the receipt matched ({@link checkCheckpointLinkExpiry}).
 *
 * Pure over bytes; no network (canopy rule C1).
 */
import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";
import { checkpointConsistencyProof } from "./checkpoint-chain.js";
import type {
  CheckpointLinkFailure,
  CheckpointLinkRecord,
  CheckpointLinkVerifiedBy,
} from "./checkpoint-link-record.js";
import type { Ks256Attestation } from "./ks256-attestation.js";
import {
  idtimestampToUnixSeconds,
  resolveDelegatedVerifyKey,
  type DelegationConstraints,
} from "./resolve-delegated-verify-key.js";
import { isParsedKs256RootKey, type RootVerifyKey } from "./root-verify-key.js";
import { resolveWithKs256Attestations } from "./select-ks256-attestation.js";

/** The per-link verifier and what it has learned so far. */
export type CheckpointLinkVerifier = {
  /** Pass as `verifyCheckpointChain({ verifySignature })`. */
  verifySignature: (
    checkpointBytes: Uint8Array,
    detachedPayload: Uint8Array,
  ) => Promise<boolean>;
  /** One record per link that verified, in fold order. */
  records: CheckpointLinkRecord[];
  /** Set when the verifier refused a link; the chain fold stops there. */
  failure(): CheckpointLinkFailure | undefined;
};

/**
 * Build the per-link signature verifier for {@link verifyCheckpointChain}.
 *
 * For each checkpoint, in fold order: resolve its label-1000 certificate
 * under `rootKeys` (with the attestation made for that certificate, if any),
 * verify the COSE signature over the FOLDED accumulator (the detached
 * payload the fold computes, never one read from the checkpoint; ADR-0046),
 * then enforce the certificate's size bound against the signed size. KS256
 * roots vouch only for certificates; only ES256 roots may verify a
 * checkpoint directly.
 *
 * The callback must be used for exactly one fold: link indices are the call
 * count.
 *
 * @param opts.rootKeys - ES256 keys and KS256 addresses, from genesis or
 *   caller-known log keys.
 * @param opts.attestations - ERC-1271 attestations for KS256 contract
 *   roots; each certificate takes the one with its digest and signature
 *   hash ({@link selectKs256Attestation}).
 * @param opts.forestChainId - The forest genesis chain id every attestation
 *   must carry; without it a contract root fails
 *   `ks256_attestation_chain_unbound`.
 */
export function makeCheckpointLinkVerifier(opts: {
  rootKeys: readonly RootVerifyKey[];
  attestations?: readonly Ks256Attestation[] | undefined;
  forestChainId?: bigint | undefined;
}): CheckpointLinkVerifier {
  const rootKeys = [...opts.rootKeys];
  const attestations = opts.attestations ?? [];
  const es256Roots = rootKeys.filter(
    (k): k is CryptoKey => !isParsedKs256RootKey(k),
  );
  const records: CheckpointLinkRecord[] = [];
  let failure: CheckpointLinkFailure | undefined;
  let calls = 0;

  const verifySignature = async (
    checkpointBytes: Uint8Array,
    detachedPayload: Uint8Array,
  ): Promise<boolean> => {
    const index = calls++;
    const chosen = await resolveWithKs256Attestations(
      checkpointBytes,
      rootKeys,
      attestations,
      opts.forestChainId,
    );
    const resolution = chosen.resolution;
    const fail = (reason: string): false => {
      failure = { index, reason };
      if (chosen.selected !== undefined) {
        failure.attestationIndex = chosen.selected;
      }
      if (chosen.rejected.length > 0) {
        failure.attestationsRejected = chosen.rejected;
      }
      return false;
    };

    if (resolution.kind === "broken") {
      return fail(resolution.reason ?? "delegation_invalid");
    }

    let signedSize: bigint;
    try {
      signedSize = checkpointConsistencyProof(checkpointBytes).signedTreeSize2;
    } catch {
      // The fold read the same label moments ago; fail closed.
      return fail("proof_malformed");
    }

    const candidates: { key: CryptoKey; delegated: boolean }[] = [
      ...(resolution.kind === "resolved"
        ? [{ key: resolution.delegatedKey, delegated: true }]
        : []),
      ...es256Roots.map((key) => ({ key, delegated: false })),
    ];
    let signer: { key: CryptoKey; delegated: boolean } | undefined;
    for (const c of candidates) {
      if (
        await verifyCoseSign1WithParsedKey(checkpointBytes, c.key, {
          logPrefix: "checkpoint-chain",
          detachedPayload,
        })
      ) {
        signer = c;
        break;
      }
    }
    if (signer === undefined) return fail("signature_invalid");

    // A resolved certificate's limits bind the link even when a root key
    // verified it directly: stricter than univocity, which would not accept
    // a root signature alongside a certificate at all.
    const constraints =
      resolution.kind === "resolved" ? resolution.constraints : null;
    if (constraints !== null) {
      const bound = checkCheckpointLinkSizeBound(constraints, signedSize);
      if (!bound.ok) return fail(bound.reason);
    }

    let verifiedBy: CheckpointLinkVerifiedBy = "es256-root";
    if (signer.delegated) {
      const viaEs256 = await resolveDelegatedVerifyKey(
        checkpointBytes,
        es256Roots,
      );
      verifiedBy = viaEs256.kind === "resolved" ? "delegated" : "ks256-root";
    }
    // Only a selected attestation can carry a certificate (a diagnostic
    // stand-in never matches), so "needed" implies "selected".
    const attestationNeeded =
      chosen.selected !== undefined &&
      resolution.kind === "resolved" &&
      (await resolveDelegatedVerifyKey(checkpointBytes, rootKeys)).kind ===
        "broken";

    const record: CheckpointLinkRecord = {
      index,
      signedSize,
      constraints,
      verifiedBy,
      attestationNeeded,
    };
    if (chosen.rejected.length > 0) {
      record.attestationsRejected = chosen.rejected;
    }
    if (chosen.selected !== undefined) {
      record.attestationIndex = chosen.selected;
      if (attestationNeeded) {
        record.attestationUsed = bytesToHex(
          attestations[chosen.selected]!.digest,
        );
      }
    }
    records.push(record);
    return true;
  };

  return { verifySignature, records, failure: () => failure };
}

/**
 * The size bound univocity enforces on a checkpoint, judged from signed
 * data alone: with `mmrIndex = signedSize > 0 ? signedSize - 1 : 0`, reject
 * `mmrIndex < mmrStart || mmrIndex > mmrEnd` (`delegationVerifier.sol`,
 * `_Univocity.sol` passes `claimedSize > 0 ? claimedSize - 1 : 0`).
 *
 * @returns `delegation_out_of_range` on either side of the window.
 */
export function checkCheckpointLinkSizeBound(
  constraints: DelegationConstraints,
  signedSize: bigint,
): { ok: true } | { ok: false; reason: "delegation_out_of_range" } {
  const mmrIndex = signedSize > 0n ? signedSize - 1n : 0n;
  if (mmrIndex < constraints.mmrStart || mmrIndex > constraints.mmrEnd) {
    return { ok: false, reason: "delegation_out_of_range" };
  }
  return { ok: true };
}

/**
 * Expiry, judged only AFTER a receipt matched the chain, when its leaf's
 * idtimestamp and mmrIndex are bound by the leaf hash and inclusion path
 * rather than being caller claims. A link whose signed size covers the leaf
 * (`signedSize > leaf.mmrIndex`) was signed after the leaf was sequenced, so
 * a leaf time past `expiresAt` proves signing past the key's lifetime. A
 * link that does not cover the leaf says nothing about its time. Never
 * wall-clock; no `issuedAt` bound (a certificate is legitimately signed a
 * few seconds after the leaf it first covers).
 *
 * @param records - From {@link makeCheckpointLinkVerifier}.
 * @param leaf.idtimestamp - The bound leaf's snowflake idtimestamp.
 * @returns The first offending link as `at`.
 */
export function checkCheckpointLinkExpiry(
  records: readonly CheckpointLinkRecord[],
  leaf: { mmrIndex: bigint; idtimestamp: bigint },
): { ok: true } | { ok: false; reason: "delegation_expired"; at: number } {
  const leafSeconds = idtimestampToUnixSeconds(leaf.idtimestamp);
  for (const r of records) {
    if (r.constraints === null) continue;
    if (r.signedSize > leaf.mmrIndex && leafSeconds > r.constraints.expiresAt) {
      return { ok: false, reason: "delegation_expired", at: r.index };
    }
  }
  return { ok: true };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
