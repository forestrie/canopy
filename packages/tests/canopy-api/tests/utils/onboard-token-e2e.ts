/**
 * Mint CANOPY_PAYMENTS_ONBOARD_TOKEN via ops API for genesis POST e2e.
 */

import { encode as encodeCbor, decode as decodeCbor } from "cbor-x";
import type { APIRequestContext } from "@playwright/test";

const BOOTSTRAP_MINT_E2E_HELP =
  "Run via Doppler (project canopy, config dev or prod), e.g. task test:e2e. " +
  "See packages/tests/canopy-api/README.md.";

export function assertOpsAdminE2eEnv(): void {
  if (!process.env.CANOPY_OPS_ADMIN_TOKEN?.trim()) {
    throw new Error(
      `CANOPY_OPS_ADMIN_TOKEN is required to mint onboard tokens for genesis POST. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
}

/** Mint a fresh onboard token (value returned once from ops API). */
export async function mintOnboardTokenE2e(
  request: APIRequestContext,
  label = "e2e",
): Promise<string> {
  assertOpsAdminE2eEnv();
  const ops = process.env.CANOPY_OPS_ADMIN_TOKEN!.trim();
  const res = await request.post("/api/payments/onboard-tokens", {
    headers: {
      Authorization: `Bearer ${ops}`,
      "Content-Type": "application/cbor",
    },
    data: Buffer.from(encodeCbor(new Map([[1, label]])) as Uint8Array),
  });
  if (res.status() !== 201) {
    throw new Error(
      `mint onboard token: expected 201, got ${res.status()}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const body = decodeCbor(
    new Uint8Array(await res.body().then((b) => b)),
  ) as { token?: string };
  const token = body.token?.trim();
  if (!token) {
    throw new Error("mint onboard token: response missing token field");
  }
  return token;
}
