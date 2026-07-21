/**
 * Known-accumulator snapshot (FOR-297 D5): a cached, auditable chain read of
 * a Univocity log's `logState`, letting chain-anchored verification run
 * fully offline. Hoisted from `forestrie-cli/src/lib/verify-known-accumulator.ts`
 * (plan-2607-34 slice 02 Part B) so the CLI and any other consumer — e2e
 * harnesses, a future browser relying party — share one implementation
 * instead of duplicating this crypto per caller.
 *
 * Trust model (freshness / split-view): `--rpc-url` was never trust-free —
 * the RPC provider is itself a trusted chain reader. The snapshot makes that
 * trust explicit, portable, and cacheable. It binds `(chainId, univocity,
 * logId, size, block)` so anyone with RPC can re-run the read at that block
 * and confirm or disprove it — auditable, falsifiable trust, unlike a bare
 * known key.
 *
 * Staleness limits coverage, never validity: the contract's consistency
 * gating makes every anchored state a committed prefix of every later one,
 * so a peak match at snapshot size N proves inclusion at N and forever
 * after. Entries newer than the snapshot fail closed with a refresh hint.
 *
 * This module is pure — no network, no `node:*` imports (browser-safety
 * enforced by `tools/check-browser-safe.mjs`). Fetching the snapshot itself
 * over RPC is the caller's concern (forestrie-cli `fetch-accumulator`, or an
 * equivalent reader — see `verifyReceiptOfflineAgainstKnownAccumulator`'s
 * doc for why that stays out of this package).
 *
 * NEVER source the snapshot unauthenticated from the same store as the tiles
 * (the log operator's massif/checkpoint store) — that silently re-internalises
 * the operator trust this anchor exists to remove.
 */

import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import { calculateRoot, type Proof } from "@forestrie/merklelog";
import { normalizeHexAddress } from "@forestrie/chain-rpc";
import { parseReceipt } from "./parse-receipt.js";
import { univocityLeafHash } from "./leaf-commitment.js";
import { SubtleHasher } from "./subtle-hasher.js";
import type { ReceiptVerifyResult } from "./receipt-verify-result.js";

/**
 * 16/32-byte hex or UUID log id -> the 32-byte contract key (UUID in the low
 * bytes, zero-padded on the left — matches Univocity's `ToContractBytes32`).
 * Small, pure, intentionally duplicated from `forestrie-cli`'s copy (same
 * tolerance as this file's local `bytesEqual` — not security-sensitive
 * enough to force a shared-utility package for a six-line formatter).
 */
function toContractLogId(logId: string): string {
  const hex = logId.replace(/-/g, "").replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) && !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(
      `log id must be a UUID or 16/32-byte hex id, got '${logId}'`,
    );
  }
  return "0x" + hex.padStart(64, "0");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i]! ^ b[i]!;
  return x === 0;
}

/** CBOR map labels for the snapshot artifact (strict RFC 8949 §4.2). */
const LABEL_VERSION = 1;
const LABEL_CHAIN_ID = 2;
const LABEL_UNIVOCITY = 3;
const LABEL_LOG_ID = 4;
const LABEL_SIZE = 5;
const LABEL_ACCUMULATOR = 6;
const LABEL_BLOCK_NUMBER = 7;
const LABEL_BLOCK_HASH = 8;

const SNAPSHOT_VERSION = 1;

export type KnownAccumulator = {
  version: number;
  chainId: bigint;
  /** Univocity contract address (20 bytes). */
  univocity: Uint8Array;
  /** Contract log id (32 bytes, UUID zero-padded on the left). */
  logId: Uint8Array;
  /** Anchored MMR size at the snapshot block. */
  size: bigint;
  /** Anchored accumulator peaks (32 bytes each), contract order. */
  accumulator: Uint8Array[];
  blockNumber: bigint;
  /** Block hash of the read (32 bytes) — the falsifiability handle. */
  blockHash: Uint8Array;
};

/** Encode a snapshot as canonical CBOR (RFC 8949 §4.2 — hard policy). */
export function encodeKnownAccumulator(snapshot: KnownAccumulator): Uint8Array {
  return encodeCborDeterministic(
    new Map<number, unknown>([
      [LABEL_VERSION, snapshot.version],
      [LABEL_CHAIN_ID, snapshot.chainId],
      [LABEL_UNIVOCITY, snapshot.univocity],
      [LABEL_LOG_ID, snapshot.logId],
      [LABEL_SIZE, snapshot.size],
      [LABEL_ACCUMULATOR, snapshot.accumulator],
      [LABEL_BLOCK_NUMBER, snapshot.blockNumber],
      [LABEL_BLOCK_HASH, snapshot.blockHash],
    ]),
  );
}

function asBigint(v: unknown, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return BigInt(v);
  throw new Error(`known accumulator: ${what} must be an unsigned integer`);
}

function asBytes(v: unknown, length: number, what: string): Uint8Array {
  if (!(v instanceof Uint8Array) || v.length !== length) {
    throw new Error(`known accumulator: ${what} must be ${length} bytes`);
  }
  return v;
}

/** Strict decode + shape validation of a snapshot artifact. */
export function decodeKnownAccumulator(bytes: Uint8Array): KnownAccumulator {
  let decoded: unknown;
  try {
    decoded = decodeCborDeterministic(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`known accumulator is not canonical CBOR: ${message}`);
  }
  if (!(decoded instanceof Map)) {
    throw new Error("known accumulator must be a CBOR map");
  }
  const version = Number(asBigint(decoded.get(LABEL_VERSION), "version"));
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`known accumulator version ${version} not supported`);
  }
  const accRaw = decoded.get(LABEL_ACCUMULATOR);
  if (!Array.isArray(accRaw)) {
    throw new Error("known accumulator: accumulator must be an array");
  }
  const accumulator = accRaw.map((p, i) =>
    asBytes(p, 32, `accumulator peak ${i}`),
  );
  return {
    version,
    chainId: asBigint(decoded.get(LABEL_CHAIN_ID), "chainId"),
    univocity: asBytes(decoded.get(LABEL_UNIVOCITY), 20, "univocity"),
    logId: asBytes(decoded.get(LABEL_LOG_ID), 32, "logId"),
    size: asBigint(decoded.get(LABEL_SIZE), "size"),
    accumulator,
    blockNumber: asBigint(decoded.get(LABEL_BLOCK_NUMBER), "blockNumber"),
    blockHash: asBytes(decoded.get(LABEL_BLOCK_HASH), 32, "blockHash"),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reject a snapshot whose binding does not match the caller's stated target
 * BEFORE any peak math — a snapshot for the wrong log or contract must never
 * be silently accepted as an anchor. `univocity`/`logId` are raw
 * caller-supplied strings (a `0x`-address, a UUID, or hex id) — normalized
 * here so callers don't have to.
 */
export function assertSnapshotBinding(
  snapshot: KnownAccumulator,
  opts: { univocity?: string | undefined; logId?: string | undefined },
): void {
  if (opts.univocity !== undefined) {
    const given = normalizeHexAddress(opts.univocity);
    if (given === null || given !== bytesToHex(snapshot.univocity)) {
      throw new Error(
        `known accumulator is bound to univocity 0x${bytesToHex(snapshot.univocity)}, not --univocity ${opts.univocity}`,
      );
    }
  }
  if (opts.logId !== undefined) {
    const given = toContractLogId(opts.logId).slice(2);
    if (given !== bytesToHex(snapshot.logId)) {
      throw new Error(
        `known accumulator is bound to log 0x${bytesToHex(snapshot.logId)}, not --log-id ${opts.logId}`,
      );
    }
  }
}

/**
 * Offline check: is the receipt's peak one of the known-accumulator's
 * anchored peaks? Covers the two network-free cases from
 * `forestrie-cli`'s `checkReceiptAnchoredToSnapshot`:
 *
 * 1. Fail closed when the receipt's leaf postdates the snapshot (refresh).
 * 2. Exact peak match: the recomputed receipt peak is still a snapshot peak.
 *
 * Proof-path extension for stale snapshots (case 3 — needs a local massif
 * blob) stays CLI-only for now; it is a bigger, file-shaped input this
 * package's pure-bytes API doesn't take today. A receipt whose snapshot
 * covers it but isn't an exact peak returns `peak_not_in_known_accumulator`
 * — honest about not having tried extension, not a false negative dressed
 * up as one.
 *
 * The live RPC read that produces `accumulator`/`size` stays the caller's
 * concern (this package is pure — no network, browser-safety enforced by
 * `tools/check-browser-safe.mjs`); see `system-testing/src/onchain-logstate.ts`
 * or `forestrie-cli fetch-accumulator` for two independent, viem-free
 * readers (`fetch()` + manual ABI decode of `logState(bytes32)`).
 */
export async function verifyReceiptOfflineAgainstKnownAccumulator(input: {
  receiptCbor: Uint8Array;
  idtimestampBe8: Uint8Array;
  /** Leaf ContentHash: SHA-256(payload) or the grant commitment hash. */
  inner: Uint8Array;
  /** Trusted accumulator peaks at `size`, contract order. */
  accumulator: Uint8Array[];
  /** Anchored MMR size at the snapshot. */
  size: bigint;
}): Promise<ReceiptVerifyResult> {
  let parsed: { explicitPeak: Uint8Array | null; proof: Proof };
  try {
    parsed = parseReceipt(input.receiptCbor);
  } catch {
    return { ok: false, stage: "parse", reason: "receipt_malformed" };
  }

  const leafIdx =
    parsed.proof.leafIndex !== undefined
      ? parsed.proof.leafIndex
      : parsed.proof.mmrIndex!;

  // 1. Newer-than-snapshot fails CLOSED — staleness limits coverage, never
  // validity, so the remedy is a refresh, not a pass.
  if (leafIdx >= input.size) {
    return {
      ok: false,
      stage: "signature",
      reason: "receipt_newer_than_known_accumulator",
    };
  }

  let recomputedPeak: Uint8Array;
  if (parsed.explicitPeak !== null) {
    recomputedPeak = parsed.explicitPeak;
  } else {
    const hasher = new SubtleHasher();
    const leafHash = await univocityLeafHash(input.idtimestampBe8, input.inner);
    recomputedPeak = await calculateRoot(
      hasher,
      leafHash,
      parsed.proof,
      leafIdx,
    );
  }

  // 2. Exact peak match — receipt state is a snapshot-covered accumulator.
  for (const peak of input.accumulator) {
    if (bytesEqual(recomputedPeak, peak)) {
      return { ok: true, stage: "binding" };
    }
  }

  return {
    ok: false,
    stage: "signature",
    reason: "peak_not_in_known_accumulator",
  };
}
