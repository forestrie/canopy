/**
 * Bootstrap mint (POST /api/grants/bootstrap) is optional per remote deployment.
 * Local default stack (start-e2e-local-stack.mjs) must return 201 unless CANOPY_E2E_LIGHT_STACK=true.
 */

import type { APIResponse } from "@playwright/test";
import { expect, test } from "@playwright/test";

function localUsesFullStack(): boolean {
  return process.env.CANOPY_E2E_LIGHT_STACK !== "true";
}

const DEFAULT_HINT =
  "Need POST /api/grants/bootstrap + DELEGATION_SIGNER_* on the target worker, or run local full stack (see taskfiles/e2e-setup.md).";

/** Skip test if mint response indicates bootstrap is not deployed or upstream unreachable. */
export function skipIfBootstrapMintUnavailable(
  mintStatus: number,
  projectName: string,
  hint = DEFAULT_HINT,
): void {
  if (projectName === "local" && localUsesFullStack()) {
    expect(
      mintStatus,
      `Local full-stack e2e expects bootstrap mint → 201 (got ${mintStatus}). ${hint}`,
    ).toBe(201);
    return;
  }
  test.skip(
    mintStatus === 404 ||
      mintStatus === 502 ||
      mintStatus === 503 ||
      mintStatus === 504,
    `Bootstrap mint unavailable (HTTP ${mintStatus}). ${hint}`,
  );
}

/** Skip when register-grant cannot run (queue / RPC). */
export function skipIfRegisterGrantUnavailable(
  registerStatus: number,
  baseURL: string,
  projectName: string,
): void {
  if (projectName === "local" && localUsesFullStack()) {
    expect(
      registerStatus === 303 || registerStatus === 503,
      `Local full-stack: register-grant expected 303 (enqueued) or 503 (e.g. sequencing DO RPC unavailable in wrangler dev); got ${registerStatus}.`,
    ).toBe(true);
    return;
  }
  test.skip(
    registerStatus === 503,
    "Grant sequencing not configured (SEQUENCING_QUEUE / DO missing on worker).",
  );
  test.skip(
    registerStatus === 500 && baseURL.includes("127.0.0.1"),
    "Register-grant failed with 500 on localhost (Durable Object RPC between dev processes).",
  );
}

/** Parse problem-details JSON from a failed response when content-type suggests CBOR/JSON. */
export async function responseTextPreview(res: APIResponse): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
