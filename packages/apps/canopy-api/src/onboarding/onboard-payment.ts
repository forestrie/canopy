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
  const cdpCredentials =
    facilitatorRequiresAuth(env.X402_FACILITATOR_URL) &&
    env.CDP_API_KEY_ID &&
    env.CDP_API_KEY_SECRET
      ? { keyId: env.CDP_API_KEY_ID, keySecret: env.CDP_API_KEY_SECRET }
      : undefined;

  const result = await verifyPayment(
    parsed.value,
    requirements,
    env.X402_MODE ?? "verify-and-settle",
    { facilitatorUrl: env.X402_FACILITATOR_URL, cdpCredentials },
  );

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
    console.error(
      `x402 settlement queue unbound; onboard job not enqueued (idempotencyKey=${job.idempotencyKey}) — reconcile manually`,
    );
    return;
  }
  try {
    await env.X402_SETTLEMENT_QUEUE.send(job);
  } catch (err) {
    console.error(
      `x402 settlement enqueue failed (idempotencyKey=${job.idempotencyKey}): ${
        err instanceof Error ? err.message : String(err)
      } — reconcile manually`,
    );
  }
}

export { X402_HEADERS };
