import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runIdFile = resolve(__dirname, "../.e2e-run-id");

let cachedRunId: string | undefined;

/** One id per Playwright run (globalSetup writes `.e2e-run-id`); override with `E2E_RUN_ID`; Vitest falls back to random UUID. */
export function getE2eRunId(): string {
  if (cachedRunId) return cachedRunId;
  const env = process.env.E2E_RUN_ID?.trim();
  if (env) return (cachedRunId = env);
  if (existsSync(runIdFile)) {
    return (cachedRunId = readFileSync(runIdFile, "utf8").trim());
  }
  return (cachedRunId = randomUUID());
}

/** Labels for every custody key created from Playwright (not `fo-` reserved). */
export function e2eCustodianKeyLabels(): Record<string, string> {
  return {
    "e2e-test-key": "true",
    "e2e-run-id": getE2eRunId(),
  };
}
