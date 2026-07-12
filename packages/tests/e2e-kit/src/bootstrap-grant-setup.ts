import type { APIRequestContext } from "@playwright/test";
import { encodeCborDeterministic } from "@forestrie/encoding";
import {
  ScrapiRegistrationError,
  interpretRegisterRedirect,
  registerGrant,
} from "@forestrie/scrapi-client";
import { assertBootstrapMintE2eEnv } from "./e2e-env-guards.js";
import { getBootstrapVariant } from "./e2e-bootstrap-variant.js";
import { mintBootstrapGrant } from "./bootstrap-grant-flow.js";
import { playwrightFetch } from "./playwright-fetch.js";
import type { ProblemDetails } from "./problem-details.js";

/** Thrown when register-grant returns a non-303 status (carries CBOR problem + raw response). */
export class RegisterGrantHttpError extends Error {
  readonly problem?: ProblemDetails;
  constructor(
    message: string,
    readonly registerRes: import("@playwright/test").APIResponse,
    problem?: ProblemDetails,
  ) {
    super(message);
    this.name = "RegisterGrantHttpError";
    this.problem = problem;
  }
}

export interface BootstrapMintAndRegisterResult {
  grantBase64: string;
  statusUrlAbsolute: string;
}

/**
 * Mint bootstrap grant and POST register-grant. Only enforces HTTP semantics
 * (303 register with Location)—no transparent-statement shape checks.
 */
export async function bootstrapMintAndRegisterEnqueued(
  unauthorizedRequest: APIRequestContext,
  opts: { logId: string; baseURL: string; rootLogIdForMint?: string },
): Promise<BootstrapMintAndRegisterResult> {
  assertBootstrapMintE2eEnv();
  const rootLogId = opts.rootLogIdForMint ?? opts.logId;
  const variant = getBootstrapVariant("es256");
  const { grantBase64 } = await mintBootstrapGrant(
    unauthorizedRequest,
    rootLogId,
    variant,
  );

  try {
    const { statusUrl } = await registerGrant({
      baseUrl: opts.baseURL,
      bootstrapLogId: rootLogId,
      grantBase64,
      fetchImpl: playwrightFetch(unauthorizedRequest),
    });
    return { grantBase64, statusUrlAbsolute: statusUrl };
  } catch (err) {
    if (err instanceof ScrapiRegistrationError) {
      throw new Error(
        `register-grant: expected 303, got ${err.httpStatus} (body preview: ${err.detail})`,
      );
    }
    throw err;
  }
}

/**
 * POST /register/{bootstrap}/grants with Forestrie-Grant; expects 303 + registration
 * status Location. Kept Playwright-native so RegisterGrantHttpError can carry the
 * raw APIResponse for diagnostics; the 303/Location/problem interpretation is the
 * shared @forestrie/scrapi-client contract (`interpretRegisterRedirect`).
 */
export async function postRegisterGrantExpect303(
  unauthorizedRequest: APIRequestContext,
  opts: {
    bootstrapLogId: string;
    baseURL: string;
    grantBase64: string;
    parentGrantBase64?: string;
  },
): Promise<{ statusUrlAbsolute: string }> {
  const headers: Record<string, string> = {
    Authorization: `Forestrie-Grant ${opts.grantBase64}`,
  };
  const post: {
    headers: Record<string, string>;
    maxRedirects: number;
    data?: Buffer;
  } = { headers, maxRedirects: 0 };
  if (opts.parentGrantBase64) {
    // CBOR body shape per the scrapi-client contract: { parentGrant: <bytes> }
    // (grants.md §11).
    const parentBytes = new Uint8Array(
      Buffer.from(opts.parentGrantBase64, "base64"),
    );
    headers["Content-Type"] = "application/cbor";
    post.data = Buffer.from(
      encodeCborDeterministic({ parentGrant: parentBytes }),
    );
  }
  const registerRes = await unauthorizedRequest.post(
    `/register/${opts.bootstrapLogId}/grants`,
    post,
  );
  try {
    const { statusUrl } = interpretRegisterRedirect(
      {
        status: registerRes.status(),
        location: registerRes.headers()["location"],
        body: new Uint8Array(await registerRes.body()),
      },
      opts.baseURL,
    );
    return { statusUrlAbsolute: statusUrl };
  } catch (err) {
    if (err instanceof ScrapiRegistrationError) {
      if (err.httpStatus === 303) {
        throw new Error("register-grant: 303 without Location");
      }
      throw new RegisterGrantHttpError(
        `register-grant: expected 303, got ${err.httpStatus} (${err.detail})`,
        registerRes,
        err.problem,
      );
    }
    throw err;
  }
}
