/**
 * Credits purchase pay-e2e (plan-2607-43 slice 04): 402 challenge → EIP-3009
 * signature → 202 accepted, against the pinned dev univocity instance (the
 * observe-soak account — a purchase here is also the top-up that makes lane-A
 * arming safe).
 *
 * Requires the funded Base Sepolia payer wallet `CANOPY_X402_DEV_PRIVATE_KEY`
 * (skips otherwise — real testnet USDC moves). When `X402_SETTLEMENT_URL` and
 * the ops token are present, also polls the receivables read until the
 * settled credits land.
 */
import { expectAPI as expect, test } from "@e2e-fixtures/auth";
import {
  purchaseCreditsE2e,
  univocityInstanceIdE2e,
  usdcBalanceE2e,
  x402PayerAddressE2e,
  x402PayerKeyE2e,
} from "@forestrie/canopy-e2e-kit";

const PAYER_KEY = x402PayerKeyE2e();
const PINNED_ADDR = process.env.UNIVOCITY_CONTRACT_ADDRESS?.trim();
const CHAIN_ID = (process.env.E2E_UNIVOCITY_CHAIN_ID ?? "84532").trim();
const SETTLEMENT_URL = process.env.X402_SETTLEMENT_URL?.trim();
const OPS = process.env.CANOPY_OPS_ADMIN_TOKEN?.trim();

const CREDITS = 5;
/** Settlement is async (queue + on-chain tx); generous but bounded. */
const SETTLE_POLL_TIMEOUT_MS = 120_000;
const SETTLE_POLL_INTERVAL_MS = 5_000;

test.describe("credits purchase (x402 pay e2e)", () => {
  test.skip(
    !PAYER_KEY,
    "no payer key (CANOPY_X402_DEV_PRIVATE_KEY or DEPLOY_KEY) — pay e2e needs the funded dev wallet",
  );
  test.skip(
    !PINNED_ADDR,
    "UNIVOCITY_CONTRACT_ADDRESS not set — no pinned registered instance",
  );

  test("402 challenge is payable and credits land after settlement", async ({
    request,
  }) => {
    // Unfunded payer is an environment condition, not a defect: skip so the
    // suite stays green until the wallet holds USDC for this purchase
    // (nominal pricing: 5 credits = $0.05).
    const payer = x402PayerAddressE2e()!;
    const balance = await usdcBalanceE2e(payer);
    const needed = 10_000n * BigInt(CREDITS);
    test.skip(
      balance < needed,
      `payer ${payer} holds ${balance} atomic USDC < ${needed} needed — fund it on Base Sepolia`,
    );

    const binding = { chainId: CHAIN_ID, univocityAddr: PINNED_ADDR! };
    const id = univocityInstanceIdE2e(binding);

    let before: number | null = null;
    if (SETTLEMENT_URL && OPS) {
      before = await readCreditsBalance(id);
    }

    const purchase = await purchaseCreditsE2e(request, binding, CREDITS);
    expect(purchase.univocityInstanceId).toBe(id);
    expect(purchase.credits).toBe(CREDITS);

    if (before === null) {
      // No settlement observability configured: the 202 (challenge verified,
      // authorization claimed, job enqueued) is the assertable surface.
      return;
    }

    const deadline = Date.now() + SETTLE_POLL_TIMEOUT_MS;
    let latest = before;
    while (Date.now() < deadline) {
      latest = (await readCreditsBalance(id)) ?? latest;
      if (latest >= before + CREDITS) break;
      await new Promise((r) => setTimeout(r, SETTLE_POLL_INTERVAL_MS));
    }
    expect(latest).toBeGreaterThanOrEqual(before + CREDITS);
  });
});

async function readCreditsBalance(id: string): Promise<number | null> {
  const res = await fetch(
    `${SETTLEMENT_URL}/admin/receivables/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${OPS}` } },
  );
  if (res.status === 404) return 0;
  if (!res.ok) {
    throw new Error(`receivables read failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    entitlement?: { creditsBalance?: number };
  };
  return body.entitlement?.creditsBalance ?? 0;
}
