/**
 * Mint CANOPY_PAYMENTS_ONBOARD_TOKEN via ops API for genesis POST e2e.
 *
 * Bindings are mandatory on every token (ADR-0059 decision 8), and a
 * break-glass mint reserves its univocity instance. System e2e reuses one
 * pinned dev contract across runs and across ephemeral forests, which is
 * exactly the "abandoned R" case the ops release route exists for
 * (plan-2607-02 R4) — so minting here releases any prior claim first, which
 * doubles as the release route's system-level exercise.
 */

import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import type { APIRequestContext } from "@playwright/test";

const BOOTSTRAP_MINT_E2E_HELP =
  "Run via Doppler (project canopy, config dev or prod), e.g. task test:e2e. " +
  "See packages/tests/canopy-api/README.md.";

export interface E2eChainBinding {
  chainId: string;
  univocityAddr: string | Uint8Array;
}

export function assertOpsAdminE2eEnv(): void {
  if (!process.env.CANOPY_OPS_ADMIN_TOKEN?.trim()) {
    throw new Error(
      `CANOPY_OPS_ADMIN_TOKEN is required to mint onboard tokens for genesis POST. ${BOOTSTRAP_MINT_E2E_HELP}`,
    );
  }
}

function addrHex(addr: string | Uint8Array): string {
  if (typeof addr === "string") {
    return addr.trim().toLowerCase().replace(/^0x/, "");
  }
  return Array.from(addr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical univocity instance id for an e2e chain binding. */
export function univocityInstanceIdE2e(binding: E2eChainBinding): string {
  return `eip155:${binding.chainId.trim()}:0x${addrHex(binding.univocityAddr)}`;
}

/**
 * Best-effort release of the instance reservation for `binding` via the ops
 * chain-bindings route. 404 (nothing held) is success; no-op when the ops
 * token is absent.
 */
export async function releaseChainBindingClaimE2e(
  request: APIRequestContext,
  binding: E2eChainBinding,
): Promise<void> {
  const ops = process.env.CANOPY_OPS_ADMIN_TOKEN?.trim();
  if (!ops) return;
  const id = encodeURIComponent(univocityInstanceIdE2e(binding));
  const res = await request.delete(`/api/payments/chain-bindings/${id}`, {
    headers: { Authorization: `Bearer ${ops}` },
  });
  if (res.status() !== 200 && res.status() !== 404) {
    throw new Error(
      `release chain-binding claim: expected 200 or 404, got ${res.status()}: ${(await res.text()).slice(0, 300)}`,
    );
  }
}

/** Mint a fresh onboard token (value returned once from ops API). */
export async function mintOnboardTokenE2e(
  request: APIRequestContext,
  binding: E2eChainBinding,
  label = "e2e",
): Promise<string> {
  assertOpsAdminE2eEnv();
  await releaseChainBindingClaimE2e(request, binding);
  const ops = process.env.CANOPY_OPS_ADMIN_TOKEN!.trim();
  const res = await request.post("/api/payments/onboard-tokens", {
    headers: {
      Authorization: `Bearer ${ops}`,
      "Content-Type": "application/cbor",
    },
    data: Buffer.from(
      encodeCborDeterministic(
        new Map<number, unknown>([
          [1, label],
          [3, binding.chainId.trim()],
          [4, addrHex(binding.univocityAddr)],
        ]),
      ),
    ),
  });
  if (res.status() !== 201) {
    throw new Error(
      `mint onboard token: expected 201, got ${res.status()}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const body = decodeCborDeterministic(new Uint8Array(await res.body()));
  const tokenRaw = body instanceof Map ? body.get("token") : undefined;
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : undefined;
  if (!token) {
    throw new Error("mint onboard token: response missing token field");
  }
  return token;
}
