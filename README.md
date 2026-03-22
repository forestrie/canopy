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

4. Hydrate **repo-root `.env`** (gitignored) from Doppler (see `taskfiles/vars.yml`), e.g.:
   ```bash
   task vars:doppler:dev
   ```
   Include tokens such as **`R2_ADMIN`**, **`R2_WRITER`**, **`R2_READER`**, **`QUEUE_ADMIN`** in that Doppler config (or add them to `.env` if you maintain it by hand).

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

Local automation and Task read **repo-root `.env` only** (`Taskfile.dist.yml` → `dotenv: [".env"]`; file is gitignored). Hydrate it with **`task vars:doppler:dev`** / **`vars:doppler:prod`** or edit by hand.

Key variables:

- `CANOPY_ID` - Canopy instance identifier for resource naming
- `FOREST_PROJECT_ID` - External Forest project reference for integration
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID
- `R2_ADMIN`, `R2_WRITER`, `R2_READER` - API tokens for different access levels

## x402 Payment Setup (Dev)

The Canopy API uses the x402 payment protocol to gate statement registration.
In the dev environment, payments settle on **Base Sepolia** using testnet USDC.

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

### 3. Configure the Private Key

Add the dev wallet's private key to **`.env`**:

```bash
# Shared x402 dev payer wallet (Base Sepolia)
CANOPY_X402_DEV_PRIVATE_KEY=0x<your-64-hex-char-private-key>
```

This key is used by:
- SCRAPI Taskfile flows (`task scrapi:register-statement:*`, smoke tests)
- k6 performance tests
- Any other local x402 tooling

### 4. Optional: Balance Guardrail

To enable a warning when your dev wallet's USDC balance drops below 50% of a
configured daily faucet claim, add:

```bash
# Expected daily faucet claim in USDC (e.g. 100)
CANOPY_X402_DEV_DAILY_CLAIM_USDC=100

# Optional: custom RPC endpoint (defaults to https://sepolia.base.org)
# CANOPY_X402_DEV_RPC_URL=https://your-rpc-endpoint

# Optional: fail instead of warn when balance is low
# CANOPY_X402_DEV_BALANCE_STRICT=true
```

### 5. Automated Faucet Refill (Optional)

To automate faucet funding, configure CDP API credentials in **`.env`**:

```bash
CDP_API_KEY_ID=your-cdp-api-key-id
CDP_API_KEY_SECRET="-----BEGIN EC PRIVATE KEY-----
...
-----END EC PRIVATE KEY-----"
```

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

With the dev wallet configured, you can run SCRAPI tasks against the dev API:

```bash
# Register a single statement and fetch its receipt
task scrapi:register-statement:hello

# Run a small smoke test (3 statements in parallel)
task scrapi:smoke:3

# Run all smoke tests
task scrapi:smoke
```

These tasks will:
1. POST to `/entries` without a payment header, receiving a 402.
2. Extract the `Payment-Required` header from the 402 response.
3. Sign a real x402 payment using your dev wallet.
4. Retry the POST with the signed `Payment-Signature` header.
5. Poll for sequencing completion and (for `register-statement`) fetch the
   receipt.

## References

- [SCITT Architecture](https://www.ietf.org/archive/id/draft-ietf-scitt-architecture-22.txt)
- [SCRAPI Specification](https://www.ietf.org/archive/id/draft-ietf-scitt-scrapi-05.txt)
- [COSE Receipts MMR Profile](https://www.ietf.org/archive/id/draft-bryce-cose-receipts-mmr-profile-00.txt)
