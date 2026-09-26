/**
 * Review finding O3: `sealedSizeFromCheckpoint` (resolve-receipt.ts) used to
 * wrap the D9 protected-header conformance read in a bare `catch` and return
 * `null` — the same value it returns for a checkpoint that simply carries no
 * consistency proof yet. That made a sealer emitting a header canopy rejects
 * indistinguishable, in the API's own logs, from routine "not sealed yet".
 *
 * `sealedSizeFromCheckpoint` now lets a D9 conformance failure propagate as a
 * throw instead. `buildReceiptForEntry`'s outer `catch` is the only place
 * that observes it directly (it is exported; `resolveReceipt`'s equivalent
 * internal call is exercised end-to-end in scrapi-flow.test.ts and shares
 * the same fix). This file checks that the throw is (a) still caught —
 * `buildReceiptForEntry`'s documented "returns null on error" contract is
 * unchanged — and (b) now logged, so the failure is attributable.
 */
import { encodeCborDeterministic } from "@forestrie/encoding";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildReceiptForEntry } from "../src/scrapi/resolve-receipt.js";
import {
  encodePeakReceiptCoseSign1,
  mmrsCheckpointKey,
} from "./helpers/mmrs-r2-fixture.js";

const MASSIF_HEIGHT = 3;
const LOG_ID = "b2222222-2222-4222-8222-222222222222";

function proveEnvHasMMRSBucket(e: unknown): asserts e is { R2_MMRS: R2Bucket } {
  if (!e || typeof e !== "object" || !("R2_MMRS" in e)) {
    throw new Error("test env missing R2_MMRS binding");
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildReceiptForEntry — D9 protected-header conformance (review finding O3)", () => {
  it("still returns null (contract unchanged) but now logs the specific reason for a non-canonical protected header", async () => {
    proveEnvHasMMRSBucket(env);

    const placeholderPeak = encodePeakReceiptCoseSign1(
      new Uint8Array(),
      new Map(),
      new Uint8Array(),
    );

    // The sealer's canonical header is `{1: -7, 395: 3, -65933: 8}`
    // (`a3012619018b033a0001018c08`). This vector carries the identical
    // three pairs in REVERSE key order — out of canonical order, which
    // RFC 8949 §4.2 / ADR-0066 D9 reject. Shared with the
    // "reject/keys-reversed" row in
    // packages/shared/encoding/src/protected-header-conformance.test.ts.
    const malformedProtected = Uint8Array.from(
      Buffer.from("a33a0001018c0819018b030126", "hex"),
    );
    const consistencyProof = encodeCborDeterministic([0n, 8n, [], []]);
    const checkpointUnprotected = new Map<number, unknown>([
      [396, new Map<number, unknown>([[-2, consistencyProof]])],
      [-65931, [placeholderPeak]],
    ]);
    const checkpointBytes = encodeCborDeterministic([
      malformedProtected,
      checkpointUnprotected,
      null,
      new Uint8Array(),
    ]) as Uint8Array;

    await env.R2_MMRS.put(
      mmrsCheckpointKey(LOG_ID, MASSIF_HEIGHT, 0n),
      checkpointBytes,
    );
    // No massif object is written: `buildReceiptForEntry` reads and decodes
    // the checkpoint before it ever looks at the massif, so the malformed
    // header is reached (and throws) first.

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await buildReceiptForEntry(
      LOG_ID,
      MASSIF_HEIGHT,
      1n,
      env.R2_MMRS,
    );

    expect(result).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls
      .map((call) => call.map((arg) => String(arg)).join(" "))
      .join("\n");
    expect(logged).toMatch(/out of canonical order/);
  });
});
