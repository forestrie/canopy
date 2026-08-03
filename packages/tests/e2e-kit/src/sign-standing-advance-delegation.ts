/**
 * Sign the STANDING delegate-key entry — delegation-in-advance (ADR-0050 C3).
 *
 * ADR-0050 §2: the coordinator's pending-delegation listing is UNIFORM. Every
 * entry is "a key you may delegate to" — carrying a window for on-demand
 * pendings, and NO window for the standing delegate key, which is always listed
 * for a log with a registered public root and a signing route. Signers "handle
 * every entry identically", signing a certificate that covers at least the
 * demanded window if present, "with a horizon and TTL of their choosing
 * (conventionally mmrStart = 0)". There is no `kind` discriminator.
 *
 * WHY THIS EXISTS. The kit only ever signed WINDOWED entries
 * (`signPendingBootstrapDelegations` filters the window-less one out), so the
 * standing key never received a certificate: the sealer's coverage-matched lease
 * lookup found nothing covering its true seal window and deferred forever on
 * "delegation material pending", while the poll reported an empty queue and
 * receipts 404'd at the deadline.
 *
 * That was invisible on a LONG-LIVED pinned instance, whose root had standing
 * delegation established once, long ago. Retiring the pins in favour of a
 * per-run deploy (FOR-531) made every root brand new, and all six bootstrap
 * specs failed on it the first time they ran.
 *
 * `signAdvanceDelegation` in `coordinator-delegation-helpers.ts` implements the
 * same contract but is ES256-only (`rootKeyPair: CryptoKeyPair`) and had zero
 * callers. This is the variant-aware form, taking the same
 * `BootstrapSigningContext` the bootstrap flow already builds, so ES256 and
 * KS256 roots are covered by one call. Ported from the proven implementation in
 * `system-testing/tests/support/advance-delegation.ts`.
 */

import type { APIRequestContext } from "@playwright/test";
import type { BootstrapSigningContext } from "./bootstrap-delegation-coordinator.js";
import { base64ToBytes } from "@forestrie/grant-builder";
import {
  buildByokDelegationMaterial,
  buildKs256BootstrapDelegationMaterial,
  bytesToBase64,
} from "./coordinator-delegation-helpers.js";
import { assertGoCompatibleDelegatedKeyInCertificate } from "./delegation-cbor-contract.js";

/**
 * Horizon for the advance certificate, matching the kit's own
 * sign-advance-delegation tests. On-chain `publishCheckpoint` enforces
 * `mmrIndex ∈ [start, end]`, so this bounds how far the standing key stays
 * usable; 2^16-1 covers any log a system test builds.
 */
export const ADVANCE_HORIZON_MMR_END = 65535;

type StandingEntry = {
  delegatedPublicKey: string;
  mmrStart?: number;
  mmrEnd?: number;
  suggestedTtlSeconds?: number;
};

export type StandingAdvanceSignOutcome =
  | { signed: true; delegatedPublicKey: string }
  | { signed: false; reason: string };

/**
 * Delegate to the log's standing sealer key over `[0, horizon]`.
 *
 * Returns `{ signed: false }` rather than throwing when the standing entry is
 * not listed yet: the coordinator registers the standing key asynchronously, so
 * an early call legitimately sees nothing and the caller should retry.
 */
export async function signStandingAdvanceDelegation(opts: {
  request: APIRequestContext;
  coordinatorUrl: string;
  coordinatorToken: string;
  logId: string;
  logIdHex32: string;
  signingContext: BootstrapSigningContext;
  horizonMmrEnd?: number;
}): Promise<StandingAdvanceSignOutcome> {
  const pending = await opts.request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/pending-delegation`,
    { headers: { authorization: `Bearer ${opts.coordinatorToken}` } },
  );
  if (!pending.ok()) {
    throw new Error(
      `GET pending-delegation: ${pending.status()} ${(await pending.text()).slice(0, 300)}`,
    );
  }
  const body = (await pending.json()) as { entries?: StandingEntry[] };
  const entries = body.entries ?? [];

  // The standing entry is the window-less one, identified exactly as
  // `signAdvanceDelegation` does so both agree on what "standing" means.
  const standing = entries.find(
    (e) => e.mmrStart === undefined && e.suggestedTtlSeconds !== undefined,
  );
  if (!standing) {
    return { signed: false, reason: "no standing delegate-key entry yet" };
  }

  const mmrStart = 0;
  const mmrEnd = opts.horizonMmrEnd ?? ADVANCE_HORIZON_MMR_END;
  const delegatedPublicKey = base64ToBytes(standing.delegatedPublicKey);

  const material = opts.signingContext.es256RootKeyPair
    ? await buildByokDelegationMaterial({
        rootKeyPair: opts.signingContext.es256RootKeyPair,
        logIdHex32: opts.logIdHex32,
        mmrStart,
        mmrEnd,
        delegatedPublicKey,
        ttlSeconds: standing.suggestedTtlSeconds,
      })
    : await buildKs256BootstrapDelegationMaterial({
        rootSignerAddress: opts.signingContext.ks256RootAddress!,
        privateKeyHex: opts.signingContext.ks256PrivateKeyHex!,
        logIdHex32: opts.logIdHex32,
        mmrStart,
        mmrEnd,
        delegatedPublicKey,
        ttlSeconds: standing.suggestedTtlSeconds,
      });

  // REQUIRED for advance, unlike on-demand material where it is optional:
  // without it the sealer's lease carries no OnchainProof and the publisher
  // cannot publish this log's checkpoints (ADR-0050 review V3, coordinator C5).
  if (!material.onchainSignature) {
    throw new Error(
      "advance delegation requires the onchain signature — without it the " +
        "lease has no OnchainProof and checkpoints cannot be published",
    );
  }
  assertGoCompatibleDelegatedKeyInCertificate(material.certificate);

  const submit = await opts.request.post(
    `${opts.coordinatorUrl}/api/delegations/certificate`,
    {
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${opts.coordinatorToken}`,
      },
      data: {
        logId: opts.logId,
        mmrStart,
        mmrEnd,
        delegatedPublicKey: standing.delegatedPublicKey,
        certificate: bytesToBase64(material.certificate),
        issuedAt: material.issuedAt,
        expiresAt: material.expiresAt,
        onchainSignature: bytesToBase64(material.onchainSignature),
      },
    },
  );
  if (!submit.ok()) {
    throw new Error(
      `POST advance delegation: ${submit.status()} ${(await submit.text()).slice(0, 300)}`,
    );
  }

  return { signed: true, delegatedPublicKey: standing.delegatedPublicKey };
}
