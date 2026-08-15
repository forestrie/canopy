/**
 * x402 payment gate for register-grant (plan-2608-09 W2).
 *
 * A *parent* grant carrying `GF_DERIVED | GF_CHILD_PAYMENT_REQUIRED` (adr-0062)
 * makes registering a **child** grant under its authority payment-gated: the
 * child registration must present a valid `X-PAYMENT` (USDC on the configured
 * network) or the endpoint returns 402 with an `X-PAYMENT-REQUIRED` challenge.
 * The policy source is the parent's committed leaf flags — transparency-logged
 * and offline-provable (ARC-0029 L1/L2). This gate is L1 (API policy); it does
 * not depend on L3.
 *
 * **Enforcement model — read before enabling on a lane (ARC-0029 §2).** The
 * parent grant is read from the *request body* (client-supplied evidence). The
 * gate reads its committed policy bit and a coherence check
 * (`parent.logId == child.ownerLogId`), and — when a receipt-authority resolver
 * is supplied (**L2**, always the case on a live lane) — verifies the parent's
 * **inclusion receipt** before honouring the bit, so a forged or unsealed parent
 * that merely *claims* the policy is rejected rather than trusted. Two limits
 * remain, both inherent to a body-carried policy (L1/L2), not bugs:
 *   1. **A client that controls the registration can still bypass** by omitting
 *      the parent evidence (or sending a parent without the bit) — the gate then
 *      returns `null` and the child registers free. L2 grounds a *present* policy
 *      in a real receipt but cannot conjure an *absent* one; the gate is
 *      therefore enforceable only against a **cooperating/trusted registrar**
 *      (the demo's grant authority / thinker DO registering server-side, never
 *      the browser). canopy keeps no server-side grant store, so it cannot
 *      independently resolve `ownerLogId`'s policy without the evidence.
 *   2. Closing the omit-parent gap is the last step of the ARC-0029 trajectory:
 *      **L3** (sender-bound instances) makes deviation *impossible*. This plan
 *      must not depend on L3. L2 (implemented here) makes a wrongly-admitted free
 *      child *detectable* from receipts; the trusted-registrar posture (the demo
 *      registers server-side) is what actually holds on the `paid`/`either` lane
 *      today (plan-2608-09 W5, review H1).
 *
 * **Dark by default.** `REGISTER_GRANT_ADMISSION` defaults to `open` (no gate
 * anywhere, no request-body read — byte-identical to the pre-plan behaviour);
 * `paid`/`either` enforce. An ops bearer bypasses (presented via
 * `X-Ops-Authorization`, because `Authorization` already carries the signed
 * `Forestrie-Grant` credential). Reuses the onboard/credits x402 machinery
 * verbatim (challenge → verify → claim → enqueue settlement).
 *
 * **Pricing (O1): proportional to `maxHeight`.** The child grant's `maxHeight`
 * is the batch ceiling on sealed work; the charge is
 * `REGISTER_GRANT_PRICE_ATOMIC` (price per unit of `maxHeight`) × `maxHeight`,
 * so the signed authorization commits to the exact batch being bought.
 */
import type { SettlementJob } from "@canopy/x402-settlement-types";
import { checkBearer } from "@canopy/ops-bearer";
import { tryUnivocityInstanceIdFromChainBinding } from "@canopy/univocity-instance-id";
import { X402_HEADERS, buildPaymentRequiredHeader } from "./x402.js";
import {
  claimPaymentAuthorizationIdempotent,
  enqueueOnboardSettlement,
  verifyExactPayment,
  type OnboardPaymentEnv,
} from "../onboarding/onboard-payment.js";
import { requiresChildPayment } from "../grant/grant-flags.js";
import {
  grantCommitmentHashFromGrant,
  grantCommitmentHashToHex,
} from "../grant/grant-commitment.js";
import { grantAuthorize } from "./auth-grant.js";
import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import type { Grant, GrantResult } from "../grant/types.js";
import type { ParsedForestGenesis } from "../forest/parsed-forest-genesis.js";
import { bytesEqual } from "../cbor-api/cbor-map-utils.js";
import { cborResponse } from "../cbor-api/cbor-response.js";
import { CBOR_CONTENT_TYPES } from "../cbor-api/cbor-content-types.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";

/**
 * `open` — gate disabled (default; dark everywhere until a lane opts in).
 * `paid` / `either` — gate enforced when the parent carries the policy bit.
 * (`either` is reserved to also admit a future non-payment path; today it is
 * identical to `paid`. The demo lane flips to `either` — plan W5.)
 */
export type RegisterGrantAdmission = "open" | "paid" | "either";

/** Env surface the register-grant payment gate needs (superset of the shared onboard payment env). */
export interface RegisterGrantPaymentEnv extends OnboardPaymentEnv {
  REGISTER_GRANT_ADMISSION?: string;
  /** Price per unit of the child grant's `maxHeight`, atomic USDC (O1: proportional pricing). */
  REGISTER_GRANT_PRICE_ATOMIC?: string;
  /**
   * Atomic USDC per checkpoint credit — the divisor that converts grant revenue
   * into the instance-pool credits minted on settlement (O2). Same value as the
   * credits-purchase price so a dollar of grant revenue funds a dollar of
   * checkpoint credits. Defaults to `10000` ($0.01), matching credits-purchase.
   */
  X402_CREDIT_PRICE_ATOMIC?: string;
  /** Ops bearer that bypasses the gate (presented via `X-Ops-Authorization`). */
  CANOPY_OPS_ADMIN_TOKEN?: string;
}

/** $0.01 USDC — the credits-purchase default, mirrored so revenue → credits reconciles. */
const DEFAULT_CREDIT_PRICE_ATOMIC = 10000n;

/**
 * Parse `REGISTER_GRANT_ADMISSION`. Unset/empty → `open` (dark). Unrecognized
 * non-empty → `"invalid"` so the caller fails closed with a 500 rather than
 * silently disabling the gate (same posture as onboard admission).
 */
export function parseRegisterGrantAdmission(
  raw: string | undefined,
): RegisterGrantAdmission | "invalid" {
  const v = raw?.trim().toLowerCase();
  if (!v || v === "open") return "open";
  if (v === "paid") return "paid";
  if (v === "either") return "either";
  return "invalid";
}

/** Ops bypass via `X-Ops-Authorization: Bearer <token>` (Authorization carries the grant). */
function opsBypass(request: Request, token: string | undefined): boolean {
  const expected = token?.trim();
  if (!expected) return false;
  const presented = request.headers.get("X-Ops-Authorization");
  if (!presented) return false;
  // Reuse the shared constant-time compare by presenting the header as Authorization.
  const synthetic = new Request(request.url, {
    headers: { Authorization: presented },
  });
  return checkBearer(synthetic, expected) === "ok";
}

/** 20-byte univocity address → lowercase hex (no `0x`), the form the instance-id helper takes. */
function addrHex(address: Uint8Array): string {
  return Array.from(address)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** `REGISTER_GRANT_PRICE_ATOMIC` as a bigint, or `"unset"` when unconfigured/malformed. */
function unitPriceAtomic(env: RegisterGrantPaymentEnv): bigint | "unset" {
  const raw = env.REGISTER_GRANT_PRICE_ATOMIC?.trim();
  if (raw && /^[0-9]+$/.test(raw)) return BigInt(raw);
  return "unset";
}

/**
 * Revenue-equivalent instance-pool credits for a settled grant (O2):
 * `floor(paidAmount / creditPrice)`. Returns 0 when the price is malformed or
 * the amount is sub-credit — the settlement worker then skips the top-up.
 */
function poolCreditsForAmount(
  env: RegisterGrantPaymentEnv,
  amountAtomic: string,
): number {
  const raw = env.X402_CREDIT_PRICE_ATOMIC?.trim();
  const creditPrice =
    raw && /^[0-9]+$/.test(raw) && BigInt(raw) > 0n
      ? BigInt(raw)
      : DEFAULT_CREDIT_PRICE_ATOMIC;
  let amount: bigint;
  try {
    amount = BigInt(amountAtomic);
  } catch {
    return 0;
  }
  if (amount < 0n) return 0;
  return Number(amount / creditPrice);
}

/** 402 problem + `X-PAYMENT-REQUIRED` challenge header for the register-grant resource. */
function paymentRequired(
  resourceUrl: string,
  totalAtomic: string,
  env: RegisterGrantPaymentEnv,
  reason: string | undefined,
): Response {
  return cborResponse(
    {
      type: "about:blank",
      title: "Payment Required",
      status: 402,
      detail:
        reason ??
        "Payment required to register a child grant under this authority.",
      reason: "payment_required",
      amountAtomic: totalAtomic,
    },
    402,
    {
      "Content-Type": CBOR_CONTENT_TYPES.PROBLEM_CBOR,
      [X402_HEADERS.paymentRequired]: buildPaymentRequiredHeader(resourceUrl, {
        network: env.X402_NETWORK,
        payTo: env.X402_PAYTO_ADDRESS,
        priceAtomic: totalAtomic,
      }),
    },
  );
}

/**
 * Enforce the register-grant payment gate. **Only call when admission is
 * `paid`/`either`** (the caller has already parsed admission and read the parent
 * grant evidence from the body).
 *
 * @returns
 *  - `null` — proceed (gate does not apply, ops bypass, OR payment verified,
 *    claimed and a `kind:"grant"` settlement job enqueued);
 *  - a `Response` — short-circuit (402 challenge / already-used, 400 bad grant,
 *    500 misconfig).
 */
export async function enforceRegisterGrantPayment(args: {
  request: Request;
  env: RegisterGrantPaymentEnv;
  childGrant: Grant;
  parentGrant: GrantResult | null;
  genesis: ParsedForestGenesis;
  targetLogUuid: string;
  /**
   * Receipt-authority resolver for L2 parent-receipt grounding (review H1). When
   * supplied — always the case on a live lane, since the same resolver is
   * required for steady-state grant inclusion — a present, coherent,
   * payment-required parent must pass inclusion verification before its policy is
   * honoured. Omitted only in unit tests / pool-test mode, where the gate stays
   * L1 (policy read from the body flags without receipt verification).
   */
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
  /** Forest chain-binding chainId for KS256 ERC-1271 receipt verification (L2). */
  ks256ChainId?: string;
}): Promise<Response | null> {
  const {
    request,
    env,
    childGrant,
    parentGrant,
    genesis,
    targetLogUuid,
    resolveReceiptAuthority,
    ks256ChainId,
  } = args;

  // Policy lives on the parent grant's committed flags. No parent evidence, or a
  // parent without the bit → no policy → no gate. NB (see module header): an
  // *omitted* parent bypasses the gate (only a trusted registrar / L3 closes
  // that). A *present* parent is L2-grounded below before its policy is trusted.
  if (!parentGrant) return null;
  const parentFlags = parentGrant.grant.grant;
  if (!requiresChildPayment(parentFlags)) return null;
  // Coherence: the policy must come from *this child's* parent authority, not an
  // unrelated payment-required grant attached to the body.
  if (!bytesEqual(parentGrant.grant.logId, childGrant.ownerLogId)) return null;

  // Ops bearer bypasses the gate entirely (trusted operator registration).
  if (opsBypass(request, env.CANOPY_OPS_ADMIN_TOKEN)) return null;

  // L2 (ARC-0029, review H1): a present, coherent, payment-required parent must
  // be a genuinely *sealed* leaf before we act on its policy — otherwise a caller
  // could attach a hand-built COSE Sign1 that merely asserts the bit. Verify the
  // parent's inclusion receipt against its owner log's trust root (same path
  // register-grant's intermediate child-data branch uses). Fail closed: an
  // unverifiable parent is rejected here (a 403/503 from grantAuthorize), NOT
  // silently downgraded to free registration. Skipped only when no resolver is
  // wired (unit/pool-test → L1).
  if (resolveReceiptAuthority) {
    const parentReceiptError = await grantAuthorize(parentGrant, {
      enforceInclusion: true,
      resolveReceiptAuthority,
      ks256ChainId,
    });
    if (parentReceiptError) return parentReceiptError;
  }

  const maxHeight = childGrant.maxHeight ?? 0;
  if (maxHeight < 1) {
    return ClientErrors.badRequest(
      "A payment-required child grant must declare a maxHeight of at least 1.",
    );
  }
  const unit = unitPriceAtomic(env);
  if (unit === "unset") {
    return ServerErrors.internal(
      "REGISTER_GRANT_PRICE_ATOMIC is required when register-grant admission is paid/either.",
    );
  }
  const totalAtomic = (unit * BigInt(maxHeight)).toString();

  const url = new URL(request.url);
  const resourceUrl = `${url.origin}${url.pathname}`;

  const outcome = await verifyExactPayment(
    request,
    env,
    resourceUrl,
    totalAtomic,
  );
  if (outcome.status === "challenge" || outcome.status === "invalid") {
    return paymentRequired(resourceUrl, totalAtomic, env, outcome.reason);
  }

  // Claim the authorization BEFORE the grant is enqueued, so one payment admits
  // one child grant. The claim is idempotent per (authorization, grant) (review
  // M2): the settlement job is enqueued here, so if the *grant* enqueue then
  // fails downstream the payer is already charged — an identical retry must be
  // able to re-enter and re-enqueue the grant rather than lose the claim. The
  // context is the child grant's commitment: the same payment aimed at a
  // *different* grant is still rejected as a replay.
  const commitmentHex = grantCommitmentHashToHex(
    await grantCommitmentHashFromGrant(childGrant),
  );
  const claim = await claimPaymentAuthorizationIdempotent(
    env,
    outcome.payment,
    `grant:${targetLogUuid}:${commitmentHex}`,
  );
  if (claim === "conflict") {
    return paymentRequired(
      resourceUrl,
      totalAtomic,
      env,
      "payment authorization already used",
    );
  }

  const authNonce = outcome.payment.payload.payload.authorization.nonce;
  // For O2 (settlement worker credits the instance pool): carry the fee account.
  const univocityInstanceId = genesis.chainBinding
    ? tryUnivocityInstanceIdFromChainBinding({
        chainId: genesis.chainBinding.chainId,
        univocityAddr: addrHex(genesis.chainBinding.address),
      })
    : undefined;
  const job: SettlementJob = {
    jobId: crypto.randomUUID(),
    kind: "grant",
    authId: outcome.authId,
    scheme: "exact",
    payer: outcome.payment.payerAddress,
    amount: outcome.payment.amount,
    logId: targetLogUuid,
    ...(univocityInstanceId ? { univocityInstanceId } : {}),
    // O2: mint the revenue-equivalent instance-pool credits on settlement (the
    // worker only credits when the fee account is known and credits >= 1).
    // Sized from the REQUIRED charge (`totalAtomic`), not the signed amount: an
    // overpaying authorization must not inflate the instance pool, and the
    // "exact" scheme means the payer signs exactly this amount anyway (review M3).
    ...(univocityInstanceId
      ? { credits: poolCreditsForAmount(env, totalAtomic) }
      : {}),
    idempotencyKey: `grant:${targetLogUuid}:${authNonce}`,
    createdAt: Date.now(),
    payload: outcome.payment.payload,
  };
  await enqueueOnboardSettlement(env, job);

  // Paid: proceed to enqueue the grant.
  return null;
}
