# Quick Reference - Development Commands

## Development Servers

| Command | Port | R2 Works? | HMR? | Use Case |
|---------|------|-----------|------|----------|
| `pnpm dev` | 8788 | ✅ Yes | ❌ No | **DEFAULT** - API development, testing R2 |
| `pnpm dev:vite` | 5173 | ❌ No | ✅ Yes | UI development, fast iteration |

## Why Default to Wrangler?

Since your SCRAPI implementation is **API-first** and requires R2 for core functionality:

- **Accuracy over speed** - Ensures R2 operations always work
- **No surprises** - What works locally will work in production
- **Proper testing** - Can test the full SCRAPI flow
- **Correct platform bindings** - `platform.env.R2` is always available

## Common Development Workflows

### Testing SCRAPI Endpoints

```bash
# Start server (R2 enabled)
pnpm dev

# Test configuration
curl http://localhost:8788/.well-known/scitt-configuration

# Submit a statement
curl -X POST http://localhost:8788/entries \
  -H "Content-Type: application/cose; cose-type=cose-sign1" \
  -H "Authorization: Bearer test-api-key" \
  --data-binary @test.cose
```

### UI Development Only

```bash
# If you're only changing Svelte components
pnpm dev:vite

# Visit http://localhost:5173
# Note: Any R2 operations will return 503 errors
```

### Full-Stack Development

```bash
# Terminal 1: API server with R2
pnpm dev

# Terminal 2: UI with hot reload
pnpm dev:vite

# Work on http://localhost:5173 (UI)
# API calls go to http://localhost:8788
```

## Testing

| Command | Description |
|---------|-------------|
| `pnpm test:unit` | Unit tests with R2 mocking |
| `pnpm test:compliance` | SCRAPI compliance tests |
| `pnpm test:e2e` | End-to-end tests (from root) |

## Debugging

### With VSCode
```bash
# Start with Node inspector
NODE_OPTIONS='--inspect' pnpm dev

# In VSCode: F5 with "Debug Backend (Wrangler R2)"
```

### Check R2 Operations
```bash
# View Wrangler logs
pnpm dev
# R2 operations will be logged to console

# Test R2 directly
wrangler r2 object list canopy-dev-1-leaves
```

## Environment Detection in Code

```javascript
// In your +server.ts files
export const GET: RequestHandler = async ({ platform }) => {
  if (!platform?.env?.R2) {
    // Running with vite dev
    return new Response('R2 not available - use pnpm dev', {
      status: 503
    });
  }

  // R2 is available - running with wrangler dev
  const data = await platform.env.R2.get('key');
  // ... rest of your logic
};
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Platform services not available" | You're using `pnpm dev:vite`, switch to `pnpm dev` |
| "Cannot find R2 bucket" | Ensure bucket exists: `wrangler r2 bucket create canopy-dev-1-leaves` |
| Port 8788 in use | Kill process: `lsof -ti:8788 \| xargs kill` |
| Need HMR for UI | Run both `pnpm dev` and `pnpm dev:vite` |

## Key Files

- `wrangler.jsonc` - Wrangler configuration with R2 bindings
- `vite.config.ts` - Vite configuration (add proxy for hybrid mode)
- `vitest.unit.config.ts` - Test configuration with R2 mocking
- `src/lib/server/r2.ts` - R2 storage utilities
- `src/lib/test-helpers/r2-mock.ts` - R2 mocking for tests
