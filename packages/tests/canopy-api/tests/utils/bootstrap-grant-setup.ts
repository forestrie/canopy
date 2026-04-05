import type { APIRequestContext } from "@playwright/test";

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
 * (201 mint, 303 register with Location)—no transparent-statement shape checks.
 */
export async function bootstrapMintAndRegisterEnqueued(
  unauthorizedRequest: APIRequestContext,
  opts: { logId: string; baseURL: string; rootLogIdForMint?: string },
): Promise<BootstrapMintAndRegisterResult> {
  const rootLogId = opts.rootLogIdForMint ?? opts.logId;
  const mintRes = await unauthorizedRequest.post("/api/grants/bootstrap", {
    data: JSON.stringify({ rootLogId }),
    headers: { "content-type": "application/json" },
  });
  if (mintRes.status() !== 201) {
    throw new Error(
      `bootstrap mint: expected 201, got ${mintRes.status()} (body preview: ${(await mintRes.text()).slice(0, 200)})`,
    );
  }
  const grantBase64 = (await mintRes.text()).trim();

  const registerRes = await unauthorizedRequest.post("/register/grants", {
    headers: {
      Authorization: `Forestrie-Grant ${grantBase64}`,
    },
    maxRedirects: 0,
  });
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

/** POST /register/grants with Forestrie-Grant; expects 303 + registration status Location. */
export async function postRegisterGrantExpect303(
  unauthorizedRequest: APIRequestContext,
  opts: { logId: string; baseURL: string; grantBase64: string },
): Promise<{ statusUrlAbsolute: string }> {
  const registerRes = await unauthorizedRequest.post("/register/grants", {
    headers: {
      Authorization: `Forestrie-Grant ${opts.grantBase64}`,
    },
    maxRedirects: 0,
  });
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
