import type { APIRequestContext } from "@playwright/test";
import { encodeCborDeterministic } from "@forestrie/encoding";
import {
  ScrapiRegistrationError,
  interpretRegisterRedirect,
} from "@forestrie/scrapi-client";
import { signX402PaymentE2e } from "./x402-payer-e2e.js";

/**
 * Pay-on-402 register-grant, beside {@link postRegisterGrantExpect303}
 * (plan-2608-09 W3). When the target log's parent authority carries
 * `GF_CHILD_PAYMENT_REQUIRED` (adr-0062) and the lane's
 * `REGISTER_GRANT_ADMISSION` is `paid`/`either`, POSTing the child grant with no
 * `X-PAYMENT` returns 402 + an `X-PAYMENT-REQUIRED` challenge; this helper signs
 * the EIP-3009 authorization with the dev payer key and resubmits, expecting the
 * 303 registration redirect.
 *
 * When the gate is dark (admission `open`, or the parent lacks the bit) the first
 * POST already 303s; the helper returns `challenged: false` and pays nothing, so
 * it is safe to call on either lane.
 */
export interface PostRegisterGrantWithPaymentOptions {
  request: APIRequestContext;
  /** First path segment after `/register/` — forest bootstrap log id (UUID). */
  bootstrapLogId: string;
  baseURL: string;
  /** The child grant being registered (base64 transparent statement). */
  grantBase64: string;
  /**
   * The parent authority log's completed grant (base64) — carries the policy
   * bit. Sent as `{ parentGrant: <bytes> }` (grants.md §11); required for the
   * gate to fire.
   */
  parentGrantBase64?: string;
  /** Dev payer private key (resolve with `x402PayerKeyE2e()`). */
  payerKey: string;
}

export interface PostRegisterGrantWithPaymentResult {
  statusUrlAbsolute: string;
  /** True when the gate fired (402 challenge) and payment was made. */
  challenged: boolean;
  /** Atomic USDC charged (from the challenge); `"0"` when the gate was dark. */
  amountAtomic: string;
}

/** Read the `exact` option's amount from a base64 `X-PAYMENT-REQUIRED` challenge. */
function challengeAmount(headerB64: string): string {
  const decoded = JSON.parse(
    Buffer.from(headerB64, "base64").toString("utf8"),
  ) as { accepts?: Array<{ scheme: string; amount: string }> };
  return decoded.accepts?.find((o) => o.scheme === "exact")?.amount ?? "0";
}

function bodyFor(parentGrantBase64: string | undefined): {
  headers: Record<string, string>;
  data?: Buffer;
} {
  if (!parentGrantBase64) return { headers: {} };
  // CBOR body shape per the scrapi-client contract: { parentGrant: <bytes> }.
  const parentBytes = new Uint8Array(Buffer.from(parentGrantBase64, "base64"));
  return {
    headers: { "Content-Type": "application/cbor" },
    data: Buffer.from(encodeCborDeterministic({ parentGrant: parentBytes })),
  };
}

function statusUrlFrom(
  res: import("@playwright/test").APIResponse,
  body: Uint8Array,
  baseURL: string,
): string {
  const { statusUrl } = interpretRegisterRedirect(
    { status: res.status(), location: res.headers()["location"], body },
    baseURL,
  );
  return statusUrl;
}

export async function postRegisterGrantWithPayment(
  opts: PostRegisterGrantWithPaymentOptions,
): Promise<PostRegisterGrantWithPaymentResult> {
  const path = `/register/${opts.bootstrapLogId}/grants`;
  const { headers: bodyHeaders, data } = bodyFor(opts.parentGrantBase64);
  const baseHeaders: Record<string, string> = {
    Authorization: `Forestrie-Grant ${opts.grantBase64}`,
    ...bodyHeaders,
  };

  // 1) Unpaid attempt.
  const first = await opts.request.post(path, {
    headers: baseHeaders,
    maxRedirects: 0,
    ...(data ? { data } : {}),
  });

  // Gate dark (or bit absent): the unpaid request already registers.
  if (first.status() === 303) {
    return {
      statusUrlAbsolute: statusUrlFrom(
        first,
        new Uint8Array(await first.body()),
        opts.baseURL,
      ),
      challenged: false,
      amountAtomic: "0",
    };
  }
  if (first.status() !== 402) {
    throw new Error(
      `register-grant (unpaid): expected 402 or 303, got ${first.status()}: ${(
        await first.text()
      ).slice(0, 300)}`,
    );
  }
  const challenge = first.headers()["x-payment-required"];
  if (!challenge) {
    throw new Error("register-grant 402: missing X-PAYMENT-REQUIRED header");
  }
  const amountAtomic = challengeAmount(challenge);

  // 2) Sign the EIP-3009 authorization and resubmit with X-PAYMENT.
  const paid = await opts.request.post(path, {
    headers: {
      ...baseHeaders,
      "X-PAYMENT": signX402PaymentE2e(challenge, opts.payerKey),
    },
    maxRedirects: 0,
    ...(data ? { data } : {}),
  });
  try {
    return {
      statusUrlAbsolute: statusUrlFrom(
        paid,
        new Uint8Array(await paid.body()),
        opts.baseURL,
      ),
      challenged: true,
      amountAtomic,
    };
  } catch (err) {
    if (err instanceof ScrapiRegistrationError) {
      throw new Error(
        `register-grant (paid): expected 303, got ${err.httpStatus} (${err.detail})`,
      );
    }
    throw err;
  }
}
