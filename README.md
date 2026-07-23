# Canopy - SCITT/SCRAPI Transparency Log

Canopy provides a front end and API surface for a SCITT/SCRAPI personality transparency log.

- The api is built using cloudflare workers
- The frontend management console and user portals are built using sveltekit

## Prerequisites

Required tools:

- Node.js 18+
- pnpm 8+
- Wrangler CLI (Cloudflare)
- Task (taskfile.dev)

Run `task tools:check` to verify installation.

## First Time Setup

### 1. Cloudflare Account Setup

1. Create a [Cloudflare account](https://dash.cloudflare.com/sign-up)
2. Enable R2 in your account
3. Create API tokens with specific permissions (see [docs/CLOUDFLARE_TOKENS.md](docs/CLOUDFLARE_TOKENS.md)):

4. Store tokens such as **`R2_ADMIN`**, **`R2_WRITER`**, **`R2_READER`**, **`QUEUE_ADMIN`** in Doppler project **`canopy`**, config **`dev`** (or **`prod`**). Run local tasks with:
   ```bash
   doppler run --project canopy --config dev -- task cloudflare:bootstrap
   ```

### 2. Infrastructure Bootstrap

```bash
# Bootstrap Cloudflare infrastructure (creates R2 buckets and queues)
task cloudflare:bootstrap
```

Note: Queue consumers must be configured by the external sequencer project that will process messages from the queue.

For detailed infrastructure management:

```bash
task cloudflare:status --summary
```

## Environment Variables

Local automation injects secrets via **Doppler CLI** (project **`canopy`**, config **`dev`** or **`prod`**). Example:

```bash
doppler run --project canopy --config dev -- task <task-name>
```

Key variables (in Doppler or exported for CI):

- `CANOPY_ID` - Canopy instance identifier for resource naming
- `FOREST_PROJECT_ID` - External Forest project reference for integration
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID
- `R2_ADMIN`, `R2_WRITER`, `R2_READER` - API tokens for different access levels

## x402 Payment Setup (Dev)

> **Onboard is dual-auth: an onboard token is obtainable by ops action OR by
> paying USDC.** Both routes are first-class:
>
> | Route                                                        | How                                                         | Payment       |
> | ------------------------------------------------------------ | ----------------------------------------------------------- | ------------- |
> | **Operator self-onboard** (own payment-authoritative forest) | break-glass `POST /api/payments/onboard-tokens` (ops-admin) | none          |
> | **Partner onboard** (comped / negotiated)                    | request → ops **`approve`** → redeem                        | none          |
> | **Public self-serve**                                        | request → redeem with **`X-PAYMENT`**                       | USDC via x402 |
>
> An operator therefore never has to pay itself, and partners can be onboarded
> by hand, while the public can self-serve without any operator involvement.
>
> Mechanically: `POST /api/onboarding/requests/{id}/redeem` on a **`pending`**
> request returns **402** with `X-PAYMENT-REQUIRED`; on a valid `X-PAYMENT` it
> mints the token and enqueues a `SettlementJob` for the `x402-settlement`
> worker to collect. An **`approved`** request redeems with no payment and
> enqueues nothing (FOR-434, devdocs `plan-2607-38`).
>
> _Note:_ redeeming a `pending` request previously returned `409`; it now returns
> `402` — deliberate, for x402 client compatibility.
>
> _Dev:_ auto-approve is narrowed to labels prefixed **`dev-auto-`**
> (`ONBOARD_AUTO_APPROVE_LABEL_PREFIX`) so it no longer blanket-bypasses the paid
> route — use that prefix for a free dev request, any other label to exercise
> payment.
>
> **Statement registration is NOT paid.** It is authorized by **grant**
> (`Authorization: Forestrie-Grant <base64 COSE_Sign1>` on
> `POST /register/{R}/entries`). Commit
> [`57d4bbd`](https://github.com/forestrie/canopy/commit/57d4bbd) (2026-03-07)
> removed the 402 from that path and it has not returned — ARC-0016 moved the
> priced unit off the statement. Paid **grant** issuance is FOR-48, not yet built.
>
> **Mint-on-verify:** the payment is verified synchronously (the gate) and the
> token issued; settlement is collected asynchronously by the worker.
>
> Dev settles on **Base Sepolia** via the credential-free testnet facilitator
> `https://x402.org/facilitator`, so no CDP credentials are needed on the dev
> lane. Price: `X402_ONBOARD_PRICE_ATOMIC` (default `10000` = $0.01).

The setup below creates and funds a dev payer wallet, and generates signed
payments — used both for the onboard flow above and for exercising the
settlement rail directly.

### 1. Create a Dev Payer Wallet

Create a dedicated EVM wallet (EOA) for dev testing. You can use any wallet
tool (e.g. MetaMask, Foundry's `cast wallet new`, etc.) to generate a new
private key.

**Important:** This wallet is for testnet use only. Do not reuse a wallet that
holds real funds.

### 2. Fund the Wallet via Faucet

Use the [Coinbase Developer Platform faucet](https://portal.cdp.coinbase.com/)
to obtain testnet USDC on Base Sepolia:

1. Connect your dev wallet or paste its address.
2. Select **Base Sepolia** as the network.
3. Request **USDC** (and optionally ETH for gas).

The faucet has daily claim limits; for normal dev and smoke testing, one claim
per day is typically sufficient.

**Token reference:**

- Base Sepolia USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### 3. Configure the private key

Store the dev wallet private key in Doppler (project **`canopy`**, config **`dev`**)
as **`CANOPY_X402_DEV_PRIVATE_KEY`**, or export it for the current shell:

```bash
export CANOPY_X402_DEV_PRIVATE_KEY=0x<your-64-hex-char-private-key>
doppler run --project canopy --config dev -- task scrapi:register-statement:hello
```

Do not commit keys. Prefer Doppler over a repo-root `.env` file.

### 4. Optional: Balance Guardrail

To enable a warning when your dev wallet's USDC balance drops below 50% of a
configured daily faucet claim, set in Doppler (or export for local runs):

```bash
# Expected daily faucet claim in USDC (e.g. 100)
CANOPY_X402_DEV_DAILY_CLAIM_USDC=100

# Optional: custom RPC endpoint (defaults to https://sepolia.base.org)
# CANOPY_X402_DEV_RPC_URL=https://your-rpc-endpoint

# Optional: fail instead of warn when balance is low
# CANOPY_X402_DEV_BALANCE_STRICT=true
```

### 5. Automated Faucet Refill (Optional)

To automate faucet funding, configure CDP API credentials in Doppler
(`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`) or export for local runs:

Then use the faucet commands:

```bash
# Check current balance
task scrapi:x402:check-balance

# Request USDC from faucet (unconditional)
task scrapi:x402:refill

# Request USDC only if balance < 50% of daily claim
task scrapi:x402:refill-if-low
```

The `--refill-if-low` command is ideal for CI/CD workflows to ensure the dev
wallet stays funded without hitting rate limits.

### 6. Running SCRAPI Tasks

> **Note:** these tasks do not exercise a payment path — statement registration
> succeeds on **grant** authorization alone. The historical "402 then retry with
> `X-Payment`" branches were removed from `taskfiles/scrapi.yml` (they could
> never trigger). For the paid flow, see the onboard path above.

You can run SCRAPI tasks against the dev API:

```bash
# Register a single statement and fetch its receipt
task scrapi:register-statement:hello

# Run a small smoke test (3 statements in parallel)
task scrapi:smoke:3

# Run all smoke tests
task scrapi:smoke
```

These tasks will:

1. POST the signed statement to `/entries` with its grant
   (`Authorization: Forestrie-Grant …`).
2. Poll for sequencing completion and (for `register-statement`) fetch the
   receipt.

## References

- [SCITT Architecture](https://www.ietf.org/archive/id/draft-ietf-scitt-architecture-22.txt)
- [SCRAPI Specification](https://www.ietf.org/archive/id/draft-ietf-scitt-scrapi-05.txt)
- [COSE Receipts MMR Profile](https://www.ietf.org/archive/id/draft-bryce-cose-receipts-mmr-profile-00.txt)
