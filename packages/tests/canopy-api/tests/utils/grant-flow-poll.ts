import type { APIRequestContext } from "@playwright/test";

export const GRANT_FLOW_POLL_MAX = 30;
export const GRANT_FLOW_POLL_INTERVAL_MS = 500;

/**
 * Poll query-registration-status until 303 Location ends with /receipt, or return null.
 */
export async function pollUntilReceiptUrl(
  request: APIRequestContext,
  statusUrl: string,
  baseURL: string,
  pollMax = GRANT_FLOW_POLL_MAX,
  pollIntervalMs = GRANT_FLOW_POLL_INTERVAL_MS,
): Promise<string | null> {
  let url = statusUrl;
  if (!url.startsWith("http")) {
    url = `${baseURL}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  for (let i = 0; i < pollMax; i++) {
    const pollRes = await request.get(url, { maxRedirects: 0 });
    if (pollRes.status() === 303) {
      const loc = pollRes.headers()["location"];
      if (loc?.endsWith("/receipt")) {
        return loc.startsWith("http")
          ? loc
          : `${new URL(url).origin}${loc.startsWith("/") ? loc : `/${loc}`}`;
      }
    }
    if (pollRes.status() >= 400) {
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return null;
}
