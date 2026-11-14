---
id: onboarding
title: Onboarding API
status: current
created: 2026-11-14
updated: 2026-11-14
owner: robinbryce
review-by: 2027-02-14
decisions: [ADR-0009, devdocs:ADR-0059]
---

# Onboarding API

The wire for self-service onboarding: how the owner of a deployed univocity
instance obtains the onboard token that authorizes genesis
(`POST /api/forest/{R}/genesis`). The routes, request lifecycle and abuse
controls were decided in
[ADR-0009](../adr/adr-0009-self-service-onboard-provisioning.md); the
bootstrap-key attestation in
[devdocs ADR-0059 decision 8](https://github.com/forestrie/devdocs/blob/main/adr/adr-0059-instance-root-fee-accounts.md).
This page is the current wire. Where ADR-0009's key list differs, this page
is right.

Request bodies are CBOR maps with integer keys. Success bodies are CBOR maps
with text keys. Errors are `application/problem+cbor` (Concise Problem
Details), with the reason in `detail`.

## Create a request

`POST /api/onboarding/requests`, public, `Content-Type: application/cbor`,
body at most 16 KiB.

| Key | Field | Required | Value |
|-----|-------|----------|-------|
| 1 | label | yes | text, at most 128 characters |
| 2 | chainId | yes | text; a chain listed in `SUPPORTED_CHAINS_RPC` |
| 3 | univocityAddr | yes | text, 20-byte hex address of the deployed contract |
| 4 | contactEmail | yes | text, at most 320 characters |
| 5 | mandateOrigin | no | text, at most 512 characters |
| 6 | plannedForestR | no | text |
| 7 | attestation | yes | bytes: the bootstrap-key attestation below |

Success is `201` with `requestId`, `status` (`pending`, or `approved` when
the deployment auto-approves it), `expiresAt` and `redeemCode`. Keep the
redeem code: it is the only credential for redeem.

### The attestation (key 7)

Every request carries one, auto-approve included. The two exceptions do
not use this route: the operator's break-glass mint
(`POST /api/payments/onboard-tokens`) and the CREATE3 proof that a
counterfactual UUPS instance presents at genesis.

The attestation is a COSE_Sign1 signed by the key the contract's
`bootstrapConfig()` returns. canopy reads `(alg, key)` from the chain and
never trusts the envelope's own claim.

- **Protected header:** `1` (alg) equal to the chain's bootstrap alg, ES256
  (`-7`) or KS256 (`-65799`); `3` (content type)
  `application/forestrie-onboard-attestation+cwt`.
- **Payload:** a CWT claims map with `3` (aud) set to this operator's origin,
  `6` (iat), `4` (exp), and private claim `-70000`, the chain binding
  `{1: chainId, 2: univocityAddr}` (40 lower-case hex digits, no `0x`).
  `1` (iss) is optional; if present it must be
  `eip155:{chainId}:0x{univocityAddr}`.
- **Window:** iat at most 300 seconds ahead of canopy's clock, exp in the
  future, and `exp - iat` at most `ONBOARD_ATTESTATION_MAX_WINDOW_SEC`
  (default 86400).
- **Signature:** ES256 is a 64-byte `r || s` over SHA-256 of the
  Sig_structure. KS256 signs keccak-256 of the Sig_structure: for an
  externally owned account, the delegation-cose profile, a 65-byte
  `r || s || v` with low s; for a contract account, whatever the
  contract's ERC-1271 `isValidSignature` accepts.

**Single use.** The first create to present an attestation claims it, and a
later create that presents the same signed content answers `409`. Same
signed content means the same protected header and payload, whatever the
unprotected header or signature bytes. Sign a new attestation (a new iat)
for each request. A create refused by the pending cap does not use the
attestation up.

canopy keeps the accepted attestation, publicly readable, at
`payments/attestations/{instanceId}.cose` as dispute evidence, and the
claim marker at `payments/used-attestations/{hex SHA-256 of the
Sig_structure}`. The stored attestation counts as used even without a
marker, as one accepted before claims existed has none: presenting it
answers `409`, also after a later create replaces it.

### Create refusals

| Status | `detail` | Meaning |
|--------|----------|---------|
| 400 | `onboard request requires a bootstrap-key attestation (CBOR key 7)` | key 7 missing or empty |
| 400 | `label, chainId, univocityAddr, contactEmail required` | keys 1 to 4 missing |
| 400 | `chainId … is not supported …`, `univocityAddr must be 20-byte hex` | unsupported chain or bad address |
| 422 | probe detail | the address is not a univocity deployment |
| 403 | `attestation rejected: …` | the attestation failed a check above |
| 409 | `Too many pending onboard requests for this Univocity binding` | the per-binding pending cap is full |
| 409 | `attestation already used; sign a new one` | the attestation was claimed by an earlier create |
| 429 | `Onboard request rate limit exceeded; retry later` | too many creates from this client |
| 503 | `attestation verification unavailable: …`, RPC detail | chain read failed; retry |

## Redeem a request

`POST /api/onboarding/requests/{id}/redeem`, public, body `{1: redeemCode}`.
Success is `200` with `token`, `ref` and `label`. Redeeming an
already-redeemed request returns a new token and revokes the old one, until
the request expires.

| Status | `detail` | Meaning |
|--------|----------|---------|
| 401 | `Invalid redeem code` | wrong redeem code |
| 402 | payment challenge | pending request; this deployment takes payment as approval |
| 409 | `Request predates the required bootstrap-key attestation; create a new attested onboard request` | the request was created before attestation was required |
| 409 | `Request awaiting operator approval; …` | pending request; this deployment needs operator approval |
| 409 | `Request not approved`, `Request was rejected` | the request is not redeemable |
| 409 | `Univocity instance is already reserved or registered` | another holder has the instance |
| 410 | `Request expired…` | the request expired |
| 429 | `Onboard redeem rate limit exceeded; retry later` | too many redeems from this client |

## Approve a request

`POST /api/onboarding/requests/{id}/approve` (CBOR) and
`POST /api/onboarding/admin/requests/{id}/approve` (JSON), ops admin bearer.
A request created before attestation was required answers `409` with the
same `Request predates the required bootstrap-key attestation; …` detail
and stays pending.

## Genesis with the token

`POST /api/forest/{R}/genesis` with `Authorization: Bearer <token>`.
Redeem marks each token it mints from an attested request, and genesis
answers `403` for a request's token without that mark: `Onboard token has
no bootstrap-key attestation mark; redeem its onboard request again for a
new token, or create a new attested onboard request if that request had no
attestation`. Tokens from the break-glass mint are not tied to a request
and are not refused for this reason.

Tokens minted before redeem marked them have no mark, even when their
request was attested. The holder redeems the same request again, with the
same redeem code: that returns a marked token and revokes the old one, until
the request expires. Creating a new request does not help, because the old
request still holds the instance's reservation.

Requests and tokens from before attestation was required cannot be
admitted. The owner creates a new, attested request. A reservation such a
request already holds stays until the operator releases it with
`DELETE /api/payments/chain-bindings/{id}`. The operator also releases the
reservation of an attested request that expired before its holder
redeemed it again.
