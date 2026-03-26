#!/usr/bin/env node
/**
 * Poll a grant/statement status URL until 303 to receipt URL.
 * Usage: CANOPY_BASE_URL=... SCRAPI_API_KEY=... tsx poll-status.ts <statusUrl> [maxPolls] [pollIntervalMs]
 * Output: receipt URL (full) to stdout, or exit 1 on timeout.
 */

const baseUrl = process.env.CANOPY_BASE_URL?.replace(/\/$/, "");
const apiToken = process.env.SCRAPI_API_KEY?.trim();
const args = process.argv.slice(2).filter((a) => a !== "--");
const statusUrlArg = args[0];
const maxPolls = parseInt(args[1] ?? process.env.POLL_MAX ?? "120", 10);
const pollIntervalMs = parseInt(args[2] ?? process.env.POLL_INTERVAL_MS ?? "500", 10);

if (!statusUrlArg) {
  console.error("Usage: poll-status.ts <statusUrl> [maxPolls] [pollIntervalMs]");
  process.exit(1);
}

// Status URL may be path-only (relative to base) or full
const statusUrl = statusUrlArg.startsWith("http")
  ? statusUrlArg
  : `${baseUrl}${statusUrlArg.startsWith("/") ? "" : "/"}${statusUrlArg}`;

if (!baseUrl && !statusUrlArg.startsWith("http")) {
  console.error("Set CANOPY_BASE_URL when statusUrl is path-only");
  process.exit(1);
}

if (!apiToken) {
  console.error("SCRAPI_API_KEY is required");
  process.exit(1);
}

const headers: Record<string, string> = {
  Authorization: `Bearer ${apiToken}`,
};

async function poll(): Promise<string | null> {
  for (let i = 0; i < maxPolls; i++) {
    const res = await fetch(statusUrl, { redirect: "manual", headers });
    if (res.status === 303) {
      const location = res.headers.get("Location");
      if (location?.endsWith("/receipt")) {
        const full = location.startsWith("http")
        ? location
        : `${new URL(statusUrl).origin}${location.startsWith("/") ? location : `/${location}`}`;
        return full;
      }
    }
    if (res.status >= 400) {
      console.error(`Poll ${i + 1}: ${res.status} ${await res.text()}`);
      process.exit(1);
    }
    if (i < maxPolls - 1) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
  return null;
}

poll()
  .then((receiptUrl) => {
    if (receiptUrl) {
      console.log(receiptUrl);
    } else {
      console.error("Timeout waiting for receipt URL");
      process.exit(1);
    }
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
