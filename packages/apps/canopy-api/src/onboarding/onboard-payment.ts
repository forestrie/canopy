/**
 * x402 payment for onboard-token issuance (FOR-434 / FOR-433, plan-2607-38).
 *
 * Payment is an alternative *approver*: a caller with no operator relationship
 * (a `pending` request) presents a valid `X-PAYMENT` at redeem, which verifies
 * synchronously (mint-on-verify — verify is the gate, settle is collection) and
 * lets the request proceed to token issuance. A SettlementJob is then enqueued
 * for the settlement worker to collect the funds asynchronously.
 */
import type { SettlementJob } from "@canopy/x402-settlement-types";
import type { X402Mode } from "../env/x402-mode.js";
import {
  X402_HEADERS,
  buildPaymentRequiredHeader,
  parsePaymentHeader,
  getPaymentRequirementsForVerify,
} from "../scrapi/x402.js";
import type { VerifiedPayment } from "../scrapi/verified-payment.js";
import { verifyPayment } from "../scrapi/x402-facilitator.js";

/** Default onboard price: $0.01 USDC (6 decimals). Real pricing is FOR-438. */
const DEFAULT_ONBOARD_PRICE_ATOMIC = "10000";

const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";

/** Env surface the onboard payment path needs. */
export interface OnboardPaymentEnv {
  X402_MODE?: X402Mode;
  X402_FACILITATOR_URL?: string;
  X402_NETWORK?: string;
  X402_PAYTO_ADDRESS?: string;
  X402_ONBOARD_PRICE_ATOMIC?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  X402_SETTLEMENT_QUEUE?: Queue<SettlementJob>;
  R2_GRANTS: R2Bucket;
}

/**
 * Single-use claim key for a payment authorization (FOR-441).
 *
 * An EIP-3009 authorization is identified by (network, asset, from, nonce).
 * Verifying it is stateless — until settlement lands on-chain the authorization
 * is still unspent, so the facilitator answers "valid" for *every* concurrent
 * request. Without a claim, one payment mints one token per onboard request.
 */
async function paymentClaimKey(payment: VerifiedPayment): Promise<string> {
  const a = payment.payload.payload.authorization;
  const material = [
    payment.network,
    payment.payload.accepted?.asset ?? "",
    a.from,
    a.nonce,
  ]
    .join("|")
    .toLowerCase();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(material),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `payments/used-auth/${hex}`;
}

/**
 * Atomically claim a payment authorization for one-time use.
 *
 * Uses an R2 create-if-absent conditional put (`etagDoesNotMatch: "*"`), which
 * returns null when the object already exists. Must be called AFTER verify and
 * BEFORE any state transition or mint, and the write must be durable before the
 * token is issued so a crash between the two cannot release the claim.
 *
 * ---
 * **TODO(RM6) — unbounded storage.** These records are never pruned, so the
 * `payments/used-auth/` prefix grows without limit on a hot path.
 *
 * Pruning at `validBefore` is **provably safe**: past that timestamp the EIP-3009
 * authorization can never be settled, so the claim can never be needed again.
 * (Verified live: once an authorization settles, the facilitator rejects it with
 * `invalid_exact_evm_nonce_already_used` — on-chain nonce state is the ultimate
 * backstop, and this store only covers the verify→settle window, ~5 min at the
 * current `maxTimeoutSeconds` of 300.)
 *
 **Mechanism: `task cloudflare:bucket:lifecycle:used-auth`** adds an R2
 * lifecycle rule expiring this prefix 1 day after creation — no sweep, no
 * listing (a flat content-addressed prefix cannot be scanned cheaply). The rule
 * is only safe while `maxTimeoutSeconds` (300s) stays far below the expiry
 * window; a guard test asserts that headroom. **If you raise
 * `maxTimeoutSeconds`, raise the lifecycle window too.**
 *
 * `validBefore` is persisted on the record below so a *finer* sweep remains
 * possible if the lifecycle rule is ever insufficient — do not drop it. See
 * canopy `docs/plans/plan-2607-01-paid-onboard-review-remediation.md` (RM6).
 * ---
 *
 * @returns true if this caller won the claim; false if the payment was already used.
 */
export async function claimPaymentAuthorization(
  env: OnboardPaymentEnv,
  payment: VerifiedPayment,
  requestId: string,
): Promise<boolean> {
  const key = await paymentClaimKey(payment);
  const auth = payment.payload.payload.authorization;
  const body = JSON.stringify({
    requestId,
    payer: payment.payerAddress,
    amount: payment.amount,
    network: payment.network,
    nonce: auth.nonce,
    // Safe prune boundary — see TODO(RM6) above. Keep this field.
    validBefore: auth.validBefore,
    claimedAt: Date.now(),
  });
  const written = await env.R2_GRANTS.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return written !== null;
}

/** Only the CDP-hosted facilitator needs credentials; x402.org (testnet) does not. */
function facilitatorRequiresAuth(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).host === CDP_FACILITATOR_HOST;
  } catch {
    return false;
  }
}

function priceAtomic(env: OnboardPaymentEnv): string {
  return env.X402_ONBOARD_PRICE_ATOMIC?.trim() || DEFAULT_ONBOARD_PRICE_ATOMIC;
}

function reqConfig(env: OnboardPaymentEnv) {
  return {
    network: env.X402_NETWORK,
    payTo: env.X402_PAYTO_ADDRESS,
    priceAtomic: priceAtomic(env),
  };
}

/** The `X-PAYMENT-REQUIRED` challenge header value (base64) for an onboard payment. */
export function onboardPaymentRequiredHeader(
  env: OnboardPaymentEnv,
  resourceUrl: string,
): string {
  return buildPaymentRequiredHeader(resourceUrl, reqConfig(env));
}

export type OnboardPaymentOutcome =
  | { status: "challenge"; reason?: string }
  | { status: "invalid"; reason: string }
  | { status: "paid"; payment: VerifiedPayment; authId: string };

/**
 * Verify an onboard payment from the request's `X-PAYMENT` header.
 *
 * - no/unparseable header → `challenge` (respond 402 with the requirement)
 * - facilitator rejects → `invalid`
 * - valid → `paid` (proceed to mint + enqueue settlement)
 */
export async function verifyOnboardPayment(
  request: Request,
  env: OnboardPaymentEnv,
  resourceUrl: string,
): Promise<OnboardPaymentOutcome> {
  const raw = request.headers.get(X402_HEADERS.paymentSignature);
  const parsed = parsePaymentHeader(raw, {
    network: env.X402_NETWORK,
    payTo: env.X402_PAYTO_ADDRESS,
  });
  if (!parsed.ok) {
    return { status: "challenge", reason: parsed.error };
  }

  const requirements = getPaymentRequirementsForVerify(
    resourceUrl,
    reqConfig(env),
  );

  // FOR-442: never let a mode flag weaken the paid path. `verify-only` makes
  // verifyPayment return isValid WITHOUT calling the facilitator, which would
  // mint a real token for any syntactically valid payload. The onboard path
  // always performs an authoritative verify, regardless of X402_MODE.
  const mode: X402Mode = "verify-and-settle";

  // FOR-441/R3: assert the signed amount locally rather than trusting the
  // facilitator alone — parsePaymentHeader takes `amount` from the payer's own
  // authorization and only checks network/payTo.
  const required = BigInt(requirements.amount);
  let signed: bigint;
  try {
    signed = BigInt(parsed.value.amount);
  } catch {
    return { status: "invalid", reason: "payment amount is not an integer" };
  }
  if (signed < required) {
    return {
      status: "invalid",
      reason: `payment underpays: signed ${signed} < required ${required}`,
    };
  }

  const cdpCredentials =
    facilitatorRequiresAuth(env.X402_FACILITATOR_URL) &&
    env.CDP_API_KEY_ID &&
    env.CDP_API_KEY_SECRET
      ? { keyId: env.CDP_API_KEY_ID, keySecret: env.CDP_API_KEY_SECRET }
      : undefined;

  const result = await verifyPayment(parsed.value, requirements, mode, {
    facilitatorUrl: env.X402_FACILITATOR_URL,
    cdpCredentials,
  });

  if (!result.ok) return { status: "invalid", reason: result.error };
  if (!result.isValid)
    return { status: "invalid", reason: "payment not valid" };
  return { status: "paid", payment: parsed.value, authId: result.authId };
}

/**
 * Build the onboard SettlementJob. `onboardTokenRef` is filled in by the caller
 * once the token is minted, so the settlement is traceable to what it bought.
 */
export function buildOnboardSettlementJob(args: {
  payment: VerifiedPayment;
  authId: string;
  requestId: string;
  now: number;
}): SettlementJob {
  const { payment, authId, requestId, now } = args;
  const authNonce = payment.payload.payload.authorization.nonce;
  return {
    jobId: crypto.randomUUID(),
    kind: "onboard",
    authId,
    scheme: "exact",
    payer: payment.payerAddress,
    amount: payment.amount,
    requestId,
    idempotencyKey: `onboard:${requestId}:${authNonce}`,
    createdAt: now,
    payload: payment.payload,
  };
}

/**
 * Enqueue a settlement job. Mint-on-verify means the token is already issued;
 * a missing binding or a send failure must be observable (for reconciliation)
 * but must NOT fail the response — the caller has paid and holds their token.
 */
export async function enqueueOnboardSettlement(
  env: OnboardPaymentEnv,
  job: SettlementJob,
): Promise<void> {
  if (!env.X402_SETTLEMENT_QUEUE) {
    await recordUnsettled(env, job, "settlement queue unbound");
    return;
  }
  try {
    await env.X402_SETTLEMENT_QUEUE.send(job);
  } catch (err) {
    await recordUnsettled(
      env,
      job,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Persist an unsettled receivable (FOR-441/R4).
 *
 * Mint-on-verify means the token is already issued, so a failed enqueue leaves
 * money owed with nothing to collect it. A log line is not an accounting
 * record: write a durable row a reconciliation job (FOR-84) can pick up. Best
 * effort — never throw, because the caller has paid and holds their token.
 *
 * **TODO(RM6) — retention.** Unlike the claim records above these must NOT be
 * pruned on a timer: they are outstanding receivables, so the only correct
 * lifecycle is "delete once reconciled" (FOR-84 owns that). They should stay
 * rare — growth here is a signal that settlement is broken, not routine churn.
 * See canopy `docs/plans/plan-2607-01-paid-onboard-review-remediation.md`.
 */
async function recordUnsettled(
  env: OnboardPaymentEnv,
  job: SettlementJob,
  reason: string,
): Promise<void> {
  console.error(
    `x402 settlement not enqueued (idempotencyKey=${job.idempotencyKey}): ${reason} — recorded for reconciliation`,
  );
  try {
    await env.R2_GRANTS.put(
      `payments/unsettled/${job.idempotencyKey}`,
      JSON.stringify({ ...job, reason, recordedAt: Date.now() }),
      { httpMetadata: { contentType: "application/json" } },
    );
  } catch (err) {
    // Last resort: the receivable is only in logs.
    console.error(
      `failed to persist unsettled receivable ${job.idempotencyKey}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export { X402_HEADERS };
