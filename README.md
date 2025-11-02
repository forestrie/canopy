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

4. Add your API tokens to `.env.secrets`:
   ```bash
   cp .env.example.secrets .env.secrets
   # Edit .env.secrets and add your tokens:
   # R2_ADMIN, R2_WRITER, R2_READER, QUEUE_ADMIN
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

The project uses a two-file environment configuration:

- `.env` - Non-sensitive configuration (committed)
- `.env.secrets` - Sensitive credentials (git-ignored)

Key variables:

- `CANOPY_ID` - Canopy instance identifier for resource naming
- `FOREST_PROJECT_ID` - External Forest project reference for integration
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID
- `R2_ADMIN`, `R2_WRITER`, `R2_READER` - API tokens for different access levels

## References

- [SCITT Architecture](https://www.ietf.org/archive/id/draft-ietf-scitt-architecture-22.txt)
- [SCRAPI Specification](https://www.ietf.org/archive/id/draft-ietf-scitt-scrapi-05.txt)
- [COSE Receipts MMR Profile](https://www.ietf.org/archive/id/draft-bryce-cose-receipts-mmr-profile-00.txt)
