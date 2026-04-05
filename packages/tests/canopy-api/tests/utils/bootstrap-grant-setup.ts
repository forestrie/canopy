import type { APIRequestContext } from "@playwright/test";
import { custodianBootstrapSignEnv } from "./custodian-bootstrap-sign";
import { mintTransparentBootstrapGrantBase64 } from "./mint-bootstrap-grant-e2e.js";

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
 * Caller must supply curator + custodian env (see `mintTransparentBootstrapGrantBase64`).
 */
export async function bootstrapMintAndRegisterEnqueued(
  unauthorizedRequest: APIRequestContext,
  opts: { logId: string; baseURL: string; rootLogIdForMint?: string },
): Promise<BootstrapMintAndRegisterResult> {
  const rootLogId = opts.rootLogIdForMint ?? opts.logId;
  const curator = process.env.CURATOR_ADMIN_TOKEN?.trim();
  const boot = custodianBootstrapSignEnv();
  if (!curator || !boot) {
    throw new Error(
      "CURATOR_ADMIN_TOKEN and CUSTODIAN_URL + CUSTODIAN_BOOTSTRAP_APP_TOKEN required",
    );
  }
  const grantBase64 = await mintTransparentBootstrapGrantBase64({
    request: unauthorizedRequest,
    rootLogId,
    curatorToken: curator,
    custodianUrl: boot.baseUrl,
    custodianBootstrapToken: boot.token,
  });

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

/** POST /register/{bootstrap}/grants with Forestrie-Grant; expects 303 + registration status Location. */
export async function postRegisterGrantExpect303(
  unauthorizedRequest: APIRequestContext,
  opts: { bootstrapLogId: string; baseURL: string; grantBase64: string },
): Promise<{ statusUrlAbsolute: string }> {
  const registerRes = await unauthorizedRequest.post(
    `/register/${opts.bootstrapLogId}/grants`,
    {
      headers: {
        Authorization: `Forestrie-Grant ${opts.grantBase64}`,
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
  return { statusUrlAbsolute: toAbsoluteUrl(opts.baseURL, loc) };
}
