/**
 * Single-use claim for onboard attestations (ADR-0059 decision 8).
 *
 * The spent attestation is stored at `payments/attestations/{id}.cose` in a
 * publicly served bucket, so anyone can read a still-valid one and post their
 * own create with it. Verifying the signature alone therefore cannot tell the
 * owner from a replayer; the first create to present an attestation claims
 * it, and every later presentation is refused.
 *
 * Accepted residual: an attestation accepted before this deploy (before
 * single-use claims) has no marker, so whoever presents one published then
 * first can still claim it once after the deploy, until it expires. That is
 * at most 24 h + 300 s after the deploy (exp <= iat + the window, and iat at
 * most 300 s ahead of the clock when it was accepted); 1 h for CLI-signed
 * ones. No code guards it: requests created before the deploy are forfeit
 * (`hasAttestationClaim` in onboard-request-store.ts), and lanes are
 * pre-production with no real fees.
 */

import { decodeCoseSign1Parts } from "@forestrie/delegation-cose";
import { encodeSigStructure } from "@forestrie/encoding";

export interface OnboardAttestationClaimEnv {
  R2_GRANTS: R2Bucket;
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
 * Claim a verified attestation for one onboard request, with an R2
 * create-if-absent put (`etagDoesNotMatch: "*"`, null when the marker exists).
 * Call after verification and every refusal that should not burn the
 * attestation, immediately before the request record is created.
 *
 * The marker is public, like the attestation itself, and holds no secrets or
 * contact data. R2 expires markers 2 days after they are written (task
 * cf:bucket:lifecycle:used-attestations). A marker is needed only
 * until its attestation's `exp`, which verification bounds: exp <= iat + the
 * window (hard ceiling 24 h, ATTESTATION_WINDOW_CEILING_SEC) and iat <= now +
 * 300 s, so at most 24 h 5 min after the marker is written. R2 deletes an
 * object only once it reaches the age, never before.
 *
 * @returns the marker key if this caller won the claim, for create to
 *   record on the request (OnboardRequestRecord.attestationClaimKey); null
 *   if the attestation was already used.
 */
export async function claimOnboardAttestation(
  env: OnboardAttestationClaimEnv,
  attestation: Uint8Array,
  claim: OnboardAttestationClaimInput,
): Promise<string | null> {
  const key = await onboardAttestationClaimKey(attestation);
  const body = JSON.stringify({
    instanceId: claim.instanceId,
    iat: claim.iat,
    exp: claim.exp,
    usedAt: Date.now(),
  });
  const written = await env.R2_GRANTS.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written !== null ? key : null;
}
