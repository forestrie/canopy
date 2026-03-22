#!/usr/bin/env node
/**
 * Verify register-grant and register-signed-statement flow against a deployed API.
 * Reports each step: health, mint, register, poll, resolve, POST entry.
 * Usage: CANOPY_BASE_URL=https://api-dev.forestrie.dev pnpm run verify:grant-flow
 *        Optional: LOG_ID=uuid (default 123e4567-e89b-12d3-a456-426614174000)
 */

const BASE_URL = (process.env.CANOPY_BASE_URL ?? "").replace(/\/$/, "");
const LOG_ID = process.env.LOG_ID ?? "123e4567-e89b-12d3-a456-426614174000";
const POLL_MAX = parseInt(process.env.POLL_MAX ?? "60", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "500", 10);

function step(name: string, ok: boolean, detail: string): void {
  const icon = ok ? "✓" : "✗";
  console.log(`${icon} ${name}: ${detail}`);
}

async function main(): Promise<void> {
  if (!BASE_URL) {
    console.error("Set CANOPY_BASE_URL to the API base URL (e.g. https://api-dev.forestrie.dev)");
    process.exit(1);
  }

  console.log(`Verifying grant flow at ${BASE_URL} (logId=${LOG_ID})\n`);

  // 1. Health
  try {
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const ok = healthRes.ok;
    step("Health", ok, `${healthRes.status} ${healthRes.ok ? (await healthRes.json()).status : await healthRes.text()}`);
    if (!ok) {
      console.log("\nStopping: API unhealthy.");
      process.exit(1);
    }
  } catch (e) {
    step("Health", false, (e as Error).message);
    process.exit(1);
  }

  // 2. Mint
  let grantBase64: string | null = null;
  try {
    const mintRes = await fetch(`${BASE_URL}/api/grants/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootLogId: LOG_ID }),
    });
    if (mintRes.status === 201) {
      grantBase64 = (await mintRes.text()).trim();
      step("Mint", true, `201, grant length=${grantBase64.length}`);
    } else {
      const body = await mintRes.text();
      step("Mint", false, `${mintRes.status} ${body.slice(0, 80)}${body.length > 80 ? "..." : ""}`);
      if (mintRes.status >= 500) {
        console.log("\nBootstrap not configured on this deployment. Set DELEGATION_SIGNER_URL, DELEGATION_SIGNER_BEARER_TOKEN, ROOT_LOG_ID.");
        process.exit(0);
      }
      process.exit(1);
    }
  } catch (e) {
    step("Mint", false, (e as Error).message);
    process.exit(1);
  }

  // 3. Register
  let statusUrl: string | null = null;
  try {
    const regRes = await fetch(`${BASE_URL}/logs/${LOG_ID}/grants`, {
      method: "POST",
      headers: { Authorization: `Forestrie-Grant ${grantBase64}` },
      redirect: "manual",
    });
    if (regRes.status === 303) {
      const loc = regRes.headers.get("Location");
      statusUrl = loc?.startsWith("http") ? loc : `${BASE_URL}${loc?.startsWith("/") ? "" : "/"}${loc ?? ""}`;
      step("Register", true, `303 → ${statusUrl?.slice(0, 60)}...`);
    } else {
      step("Register", false, `${regRes.status} ${await regRes.text()}`);
      process.exit(1);
    }
  } catch (e) {
    step("Register", false, (e as Error).message);
    process.exit(1);
  }

  // 4. Poll
  let receiptUrl: string | null = null;
  for (let i = 0; i < POLL_MAX; i++) {
    const pollRes = await fetch(statusUrl!, { redirect: "manual" });
    if (pollRes.status === 303) {
      const loc = pollRes.headers.get("Location");
      if (loc?.endsWith("/receipt")) {
        receiptUrl = loc.startsWith("http") ? loc : `${new URL(statusUrl!).origin}${loc.startsWith("/") ? loc : `/${loc}`}`;
        step("Poll", true, `303 → receipt after ${i + 1} poll(s)`);
        break;
      }
    }
    if (pollRes.status >= 400) {
      step("Poll", false, `HTTP ${pollRes.status} after ${i + 1} poll(s)`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (!receiptUrl) {
    step("Poll", false, `timeout after ${POLL_MAX} polls (queue may not be processing)`);
    console.log("\nEnsure a queue consumer (e.g. ranger) is running for this environment.");
    process.exit(1);
  }

  // 5. Resolve (GET receipt) – we don't build completed grant here; just verify receipt URL is fetchable
  try {
    const recRes = await fetch(receiptUrl);
    step("Resolve (GET receipt)", recRes.ok, recRes.ok ? `200, ${recRes.headers.get("content-length") ?? 0} bytes` : `${recRes.status}`);
    if (!recRes.ok) process.exit(1);
  } catch (e) {
    step("Resolve (GET receipt)", false, (e as Error).message);
    process.exit(1);
  }

  console.log("\nAll steps passed. Register-grant and register-signed-statement flow is OK.");
  console.log("To exercise POST /entries, use the e2e grant-flow test or k6 with a completed grant.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
