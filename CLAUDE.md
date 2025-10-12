# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common Development Commands

### Infrastructure Management
```bash
# Bootstrap Cloudflare resources (R2, Queues)
task cloudflare:bootstrap

# Check infrastructure status
task cloudflare:status

# Apply infrastructure changes
task cloudflare:apply

# Destroy all infrastructure (WARNING: deletes data)
task cloudflare:destroy
```

### Development Workflow
```bash
# Install all dependencies
task install

# Start development server (SvelteKit + Cloudflare Workers)
task dev

# Build entire monorepo
task build:all

# Run all tests (unit + e2e)
task test:all

# Type check TypeScript
task build:check
```

### Testing Specific Components
```bash
# Run Playwright API tests
task test:api

# Run e2e tests with UI
task test:e2e:ui

# Run tests in CI mode
task test:ci
```

## High-Level Architecture

### SCITT/SCRAPI Implementation
The system implements a transparency log following SCITT (Supply Chain Integrity, Transparency and Trust) and SCRAPI (SCITT REST API) specifications:

1. **Pre-sequencing Phase**: Statements are stored in R2 with content-addressed paths before sequencing
2. **Queue Integration**: Cloudflare Queue sends references to an external sequencer
3. **Content Addressing**: Uses MD5 hashes for content-addressed storage paths: `/logs/{logId}/leaves/{fenceIndex}/{md5Hash}`
4. **MMR Indexing**: Mock service returns fence index 0, ready for real Merkle Mountain Range integration

### Key Components

**Authentication Flow** (packages/apps/canopy/src/hooks.server.ts):
- Middleware validates API keys in Authorization header
- Public endpoints bypass authentication
- Auth hooks marked with `[AUTH HOOK POINT]` for future implementation

**R2 Storage Layer** (packages/apps/canopy/src/lib/server/r2.ts):
- Content-addressed storage with MD5 hashing
- Immutable objects with permanent caching
- Metadata tracking for sequencing status

**Queue Integration** (packages/apps/canopy/src/lib/server/queue.ts):
- Submits statement references to external sequencer
- Dead letter queue for failed messages
- Configured via Terraform

**API Layering**:
- Native layer: Direct CBOR/COSE handling (future: `/api/native/`)
- SCRAPI layer: Standards-compliant REST API (`/api/v1/`)

### Environment Configuration

The project uses separate identifiers for different purposes:

**Canopy-specific identifiers:**
- `CANOPY_ID`: Instance identifier for resource naming
  - R2 bucket: `${CANOPY_ID}-statements`
  - Queue: `${CANOPY_ID}-sequencer`
- `CANOPY_STATE_ID`: Terraform state management
  - Terraform state: `${CANOPY_STATE_ID}-tfstate`

**External references:**
- `FOREST_PROJECT_ID`: Reference to external Forest project for integration

This separation allows:
- Multiple Canopy instances with different configurations
- Independent state management per instance
- Clear distinction between Canopy resources and external Forest project references

### API Token Architecture

The project uses a three-tier token system for security:
- **R2_ADMIN**: Infrastructure management only (Terraform)
- **R2_WRITER**: Application read/write operations (SvelteKit app)
- **R2_READER**: Read-only access (optional, for monitoring)
- **QUEUE_ADMIN**: Queue management (Terraform)

The application NEVER has access to R2_ADMIN, ensuring infrastructure cannot be modified from the app.

### Deployment Strategy

**Vercel Deployment**:
- Builds SvelteKit for Cloudflare Workers adapter
- Uses edge functions for API routes
- Ignores commits outside `packages/` to prevent unnecessary builds

**Cloudflare Workers**:
- Wrangler configuration in `packages/apps/canopy/wrangler.toml`
- R2 and Queue bindings configured for local development
- Platform bindings accessible via `event.platform.env`

### Testing Approach

**API Testing** (tests/e2e/*.api.test.ts):
- Playwright used for API endpoint testing
- Tests CBOR/JSON content submission
- Validates authentication and error handling

**Local Development**:
- SvelteKit dev server proxies to Cloudflare Workers
- Wrangler provides local R2 and Queue emulation
- Environment variables loaded from `.env` and `.env.secrets`

## Important Implementation Notes

1. **MD5 for Content Addressing**: MD5 is used for content addressing, not security. It provides efficient content-addressed storage paths.

2. **Async Response Pattern**: POST to `/api/v1/logs/{logId}/statements` returns 202 Accepted with pre-sequence identity, allowing async sequencing.

3. **Terraform State Migration**: After initial bootstrap, uncomment backend configuration in `infra/terraform/providers.tf` and run `task cloudflare:migrate-state`.

4. **Auth Placeholder**: Authentication currently returns `true` for all requests. Real implementation needed at marked `[AUTH HOOK POINT]` locations.

5. **MMR Mock Service**: `getFenceMMRIndex()` returns 0. Replace with actual forestrie/datatrails massif integration.