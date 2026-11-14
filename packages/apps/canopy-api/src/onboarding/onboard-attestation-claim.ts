/**
 * Single-use claim for onboard attestations (ADR-0059 decision 8).
 *
 * The spent attestation is stored at `payments/attestations/{id}.cose` in a
 * publicly served bucket, so anyone can read a still-valid one and post their
 * own create with it. Verifying the signature alone therefore cannot tell the
 * owner from a replayer; the first create to present an attestation claims
 * it, and every later presentation is refused.
 */

import { decodeCoseSign1Parts } from "@forestrie/delegation-cose";
import { encodeSigStructure } from "@forestrie/encoding";

export interface OnboardAttestationClaimEnv {
  R2_GRANTS: R2Bucket;
}

/**
 * Public key of the instance's retained attestation: the last one accepted,
 * kept as dispute evidence (ADR-0059 decision 8).
 */
export function storedOnboardAttestationKey(instanceId: string): string {
  return `payments/attestations/${instanceId}.cose`;
}

export interface OnboardAttestationClaimInput {
  /** Univocity instance id the attestation binds to. */
  instanceId: string | undefined;
  iat: number;
  exp: number;
}

/**
 * Marker key for an attestation: SHA-256 over the COSE Sig_structure
 * `["Signature1", protected, h'', payload]`, i.e. exactly the bytes the
 * bootstrap key signed.
 *
 * Not the whole envelope and not the signature: the unprotected header is
 * outside the signed bytes and an ECDSA signature has a second valid `s`, so
 * either would let a replayer mint a "new" attestation from a public one
 * without the key.
 */
export async function onboardAttestationClaimKey(
  attestation: Uint8Array,
): Promise<string> {
  const parts = decodeCoseSign1Parts(attestation);
  const signed = encodeSigStructure(
    parts.protectedBytes,
    new Uint8Array(0),
    parts.payloadBytes,
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    signed as unknown as BufferSource,
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `payments/used-attestations/${hex}`;
}

/**
 * Claim key of the attestation stored for the instance, or undefined when
 * none is stored or it does not decode.
 */
async function storedAttestationClaimKey(
  env: OnboardAttestationClaimEnv,
  instanceId: string,
): Promise<string | undefined> {
  const stored = await env.R2_GRANTS.get(
    storedOnboardAttestationKey(instanceId),
  );
  if (!stored) return undefined;
  const bytes = new Uint8Array(await stored.arrayBuffer());
  try {
    return await onboardAttestationClaimKey(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Create-only put of a claim marker.
 *
 * @returns false when the marker already exists.
 */
async function putClaimMarker(
  env: OnboardAttestationClaimEnv,
  key: string,
  marker: { instanceId: string | undefined; iat?: number; exp?: number },
): Promise<boolean> {
  const written = await env.R2_GRANTS.put(
    key,
    JSON.stringify({ ...marker, usedAt: Date.now() }),
    {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  return written !== null;
}

/**
 * Claim a verified attestation for one onboard request, with an R2
 * create-if-absent put (`etagDoesNotMatch: "*"`, null when the marker exists).
 * Call after verification and every refusal that should not burn the
 * attestation, immediately before the request record is created.
 *
 * The marker is public, like the attestation itself, and holds no secrets or
 * contact data. Markers are kept indefinitely (one tiny object per onboard
 * request): correctness needs a marker only until `exp` plus the iat skew, but
 * keeping it avoids a lifecycle rule whose timing would have to track
 * ONBOARD_ATTESTATION_MAX_WINDOW_SEC. The marker written for the instance's
 * stored attestation holds only `instanceId` and `usedAt`.
 *
 * @returns true if this caller won the claim; false if already used.
 */
export async function claimOnboardAttestation(
  env: OnboardAttestationClaimEnv,
  attestation: Uint8Array,
  claim: OnboardAttestationClaimInput,
): Promise<boolean> {
  // Before single-use claims, every accepted attestation was stored at the
  // instance's public key with no marker, so one still inside its window
  // could win the claim below, even after a create replaced it. Mark the
  // stored one used first: presenting it is then refused, and stays refused
  // once this create replaces it.
  if (claim.instanceId) {
    const storedKey = await storedAttestationClaimKey(env, claim.instanceId);
    if (storedKey) {
      await putClaimMarker(env, storedKey, { instanceId: claim.instanceId });
    }
  }
  return putClaimMarker(env, await onboardAttestationClaimKey(attestation), {
    instanceId: claim.instanceId,
    iat: claim.iat,
    exp: claim.exp,
  });
}
