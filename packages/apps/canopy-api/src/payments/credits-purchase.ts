/**
 * `POST /api/payments/credits/{univocityInstanceId}` — payer-facing x402
 * purchase of prepaid checkpoint credits (ADR-0059 D3, plan-2607-43 slice 04).
 *
 * The route is the only unauthenticated surface under `/api/payments/**`: the
 * payment IS the authorization, exactly as on the onboard redeem path, and the
 * account id in the path is the one off-chain memo binding the transfer to a
 * fee account. Credits land only after on-chain settlement (the settlement
 * worker calls `ReceivablesDO.recordPayment` on a settled `kind="credits"`
 * job) — mint-on-verify posture does not apply to stored value.
 */
import type { SettlementJob } from "@canopy/x402-settlement-types";
import { X402_HEADERS, buildPaymentRequiredHeader } from "../scrapi/x402.js";
import {
  claimPaymentAuthorization,
  enqueueOnboardSettlement,
  verifyExactPayment,
  type OnboardPaymentEnv,
} from "../onboarding/onboard-payment.js";
import { isUnivocityInstanceId } from "@canopy/univocity-instance-id";
import { readUnivocityInstanceReservation } from "./instance-registry.js";
import type { RegistrationStoreEnv } from "./registration-store.js";

/**
 * Nominal per-credit price: $0.01 USDC (6 decimals). Deliberately just a
 * default — FOR-438's numbers are plugged in via `X402_CREDIT_PRICE_ATOMIC`
 * with no code change.
 */
const DEFAULT_CREDIT_PRICE_ATOMIC = "10000";
/** Credits bought when the caller does not say. */
const DEFAULT_CREDITS_PER_PURCHASE = 100;
/** Cap on one purchase — bounds the challenge amount a typo can produce. */
const MAX_CREDITS_PER_PURCHASE = 100_000;

export interface CreditsPurchaseEnv
  extends OnboardPaymentEnv,
    RegistrationStoreEnv {
  X402_CREDIT_PRICE_ATOMIC?: string;
}

function json(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function creditPriceAtomic(env: CreditsPurchaseEnv): bigint {
  const raw = env.X402_CREDIT_PRICE_ATOMIC?.trim();
  if (raw && /^[0-9]+$/.test(raw)) return BigInt(raw);
  return BigInt(DEFAULT_CREDIT_PRICE_ATOMIC);
}

function parseCreditsParam(url: URL): number | null {
  const raw = url.searchParams.get("credits");
  if (raw === null) return DEFAULT_CREDITS_PER_PURCHASE;
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CREDITS_PER_PURCHASE) {
    return null;
  }
  return n;
}

/**
 * Handle the credits purchase. The caller passes `?credits=N` (default
 * {@link DEFAULT_CREDITS_PER_PURCHASE}); the 402 challenge amount is
 * `N × price-per-credit`, so the signed authorization commits to the exact
 * quantity being bought.
 */
export async function handleCreditsPurchase(
  request: Request,
  univocityInstanceId: string,
  env: CreditsPurchaseEnv,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      { error: `Method ${request.method} not allowed` },
      405,
      corsHeaders,
      { Allow: "POST" },
    );
  }
  if (!isUnivocityInstanceId(univocityInstanceId)) {
    return json(
      { error: "path id must be a canonical univocity instance id" },
      400,
      corsHeaders,
    );
  }

  // Purchases require a *registered* account: the reservation record's `r`
  // (root registration) is what the ReceivablesDO account binds to, and it
  // only exists once genesis has completed the claim. Paying earlier would
  // strand value on an account that cannot exist yet.
  const record = await readUnivocityInstanceReservation(
    env,
    univocityInstanceId,
  );
  if (!record) {
    return json({ error: "unknown univocity instance" }, 404, corsHeaders);
  }
  if (record.state !== "registered" || !record.r) {
    return json(
      {
        error:
          "univocity instance is reserved but not registered; complete genesis before purchasing credits",
      },
      409,
      corsHeaders,
    );
  }

  const url = new URL(request.url);
  const credits = parseCreditsParam(url);
  if (credits === null) {
    return json(
      {
        error: `credits must be an integer in 1..${MAX_CREDITS_PER_PURCHASE}`,
      },
      400,
      corsHeaders,
    );
  }
  const totalAtomic = (creditPriceAtomic(env) * BigInt(credits)).toString();
  const resourceUrl = `${url.origin}${url.pathname}?credits=${credits}`;

  const challenge = (reason?: string): Response =>
    json(
      {
        univocityInstanceId,
        credits,
        amountAtomic: totalAtomic,
        ...(reason ? { reason } : {}),
      },
      402,
      corsHeaders,
      {
        [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(
          resourceUrl,
          {
            network: env.X402_NETWORK,
            payTo: env.X402_PAYTO_ADDRESS,
            priceAtomic: totalAtomic,
          },
        ),
      },
    );

  const outcome = await verifyExactPayment(
    request,
    env,
    resourceUrl,
    totalAtomic,
  );
  if (outcome.status === "challenge") return challenge(outcome.reason);
  if (outcome.status === "invalid") return challenge(outcome.reason);

  // Same ordering as the paid onboard path: claim the authorization before
  // anything downstream, so one payment credits one account exactly once.
  const claimed = await claimPaymentAuthorization(
    env,
    outcome.payment,
    `credits:${univocityInstanceId}`,
  );
  if (!claimed) {
    return challenge("payment authorization already used");
  }

  const authNonce = outcome.payment.payload.payload.authorization.nonce;
  const job: SettlementJob = {
    jobId: crypto.randomUUID(),
    kind: "credits",
    authId: outcome.authId,
    scheme: "exact",
    payer: outcome.payment.payerAddress,
    amount: outcome.payment.amount,
    univocityInstanceId,
    credits,
    idempotencyKey: `credits:${univocityInstanceId}:${authNonce}`,
    createdAt: Date.now(),
    payload: outcome.payment.payload,
  };
  await enqueueOnboardSettlement(env, job);

  // 202, not 200: credits land after on-chain settlement, observable via the
  // receivables status read. The claim above guarantees they land once.
  return json(
    {
      univocityInstanceId,
      credits,
      amountAtomic: totalAtomic,
      settlement: "enqueued",
    },
    202,
    corsHeaders,
  );
}
