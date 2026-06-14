import type { APIRequestContext } from "@playwright/test";
import { encode as encodeCbor } from "cbor-x";
import { assertBootstrapMintE2eEnv } from "./e2e-env-guards";
import { getBootstrapVariant } from "./e2e-bootstrap-variant.js";
import { mintBootstrapGrant } from "./bootstrap-grant-flow.js";
import {
  decodeProblemDetails,
  type ProblemDetails,
} from "./problem-details.js";

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

function toAbsoluteUrl(baseURL: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
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

  const registerRes = await unauthorizedRequest.post(
    `/register/${rootLogId}/grants`,
    {
      headers: {
        Authorization: `Forestrie-Grant ${grantBase64}`,
      },
      maxRedirects: 0,
    },
  );
  if (registerRes.status() !== 303) {
    throw new Error(
      `register-grant: expected 303, got ${registerRes.status()} (body preview: ${(await registerRes.text()).slice(0, 200)})`,
    );
  }
  const loc = registerRes.headers()["location"];
  if (!loc) {
    throw new Error("register-grant: 303 without Location");
  }
  const statusUrlAbsolute = toAbsoluteUrl(opts.baseURL, loc);
  return { grantBase64, statusUrlAbsolute };
}

/**
 * POST /register/{bootstrap}/grants with Forestrie-Grant; expects 303 + registration
 * status Location.
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
    const parentBytes = new Uint8Array(
      Buffer.from(opts.parentGrantBase64, "base64"),
    );
    headers["Content-Type"] = "application/cbor";
    post.data = Buffer.from(encodeCbor({ parentGrant: parentBytes }));
  }
  const registerRes = await unauthorizedRequest.post(
    `/register/${opts.bootstrapLogId}/grants`,
    post,
  );
  if (registerRes.status() !== 303) {
    const problem = await decodeProblemDetails(registerRes);
    const detail =
      problem?.detail ??
      ((await registerRes.text()).slice(0, 200) || "(empty body)");
    throw new RegisterGrantHttpError(
      `register-grant: expected 303, got ${registerRes.status()} (${detail})`,
      registerRes,
      problem,
    );
  }
  const loc = registerRes.headers()["location"];
  if (!loc) {
    throw new Error("register-grant: 303 without Location");
  }
  return { statusUrlAbsolute: toAbsoluteUrl(opts.baseURL, loc) };
}
