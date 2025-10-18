# Wrangler 4 and Miniflare v4 Upgrade Guide

## What's New

The project has been upgraded to:
- **Wrangler 4.43.0** - Latest Cloudflare Workers CLI
- **Miniflare 4** - Modern Workers runtime simulation
- **@cloudflare/vitest-pool-workers** - Improved testing infrastructure

## Key Changes

### 1. Wrangler Configuration (`wrangler.jsonc`)

#### Added Features:

- `compatibility_flags: ["nodejs_compat_v2"]` - Better Node.js compatibility
- `observability.enabled: true` - Built-in observability features
- `inspector.port: 9229` - Dedicated debugging configuration

### 2. Vitest Configuration (`vitest.unit.config.ts`)

#### Migration from vitest-environment-miniflare:

```typescript
// OLD (Miniflare v2)
environment: 'miniflare',
environmentOptions: { ... }

// NEW (Miniflare v4)
pool: '@cloudflare/vitest-pool-workers',
poolOptions: {
  workers: {
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { ... }
  }
}
```

### 3. Package Updates

#### Removed:
- `vitest-environment-miniflare` (deprecated)

#### Added:
- `@cloudflare/vitest-pool-workers@0.9.13`
- `miniflare@4`
- `wrangler@4.43.0`

## Benefits of the Upgrade

### Performance Improvements
- **Faster test execution** with worker pools
- **Better caching** in development
- **Reduced memory usage** in Miniflare

### Developer Experience
- **Improved debugging** with dedicated inspector configuration
- **Better error messages** from Wrangler 4
- **Native TypeScript support** improvements

### Compatibility
- **nodejs_compat_v2** flag provides better Node.js API support
- **Improved R2 simulation** in local development
- **Better parity** between local and production environments

## Running the Updated Configuration

### Development
```bash
# Start with Wrangler 4
pnpm dev

# The inspector is automatically available on port 9229
# Observability features are enabled by default
```

### Testing
```bash
# Run tests with Miniflare v4
pnpm test:unit

# Tests now use worker pools for better performance
# [vpw:info] Starting isolated runtimes for vitest.unit.config.ts...
```

### Debugging
```bash
# Debug with improved inspector
NODE_OPTIONS='--inspect' pnpm dev

# Inspector is available on port 9229 (configured in wrangler.jsonc)
```

## Migration Notes

### For Existing Tests

Tests should continue to work without changes. The new configuration maintains backward compatibility while providing improved performance.

### For New Features

Take advantage of new Wrangler 4 features:

1. **Observability**: Check the terminal for detailed metrics
2. **Improved R2 operations**: Better error messages and debugging
3. **Worker pools**: Tests run in parallel for better performance

## Troubleshooting

### Warning: Unexpected fields in dev

If you see warnings about unexpected fields, ensure they're at the correct level in `wrangler.jsonc`. The `inspector` configuration should be at the root level, not nested under `dev`.

### Peer Dependency Warnings

The warning about `@sveltejs/adapter-cloudflare` expecting Wrangler 3 can be safely ignored. The adapter works correctly with Wrangler 4.

### Test Pool Errors

If tests fail with pool errors, ensure you're using the correct configuration:
```typescript
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';
```

## Rollback Instructions

If you need to rollback to Wrangler 3:

```bash
# Downgrade packages
pnpm add -D wrangler@3.99.0 vitest-environment-miniflare@2.14.4
pnpm remove @cloudflare/vitest-pool-workers miniflare

# Revert vitest.unit.config.ts to use environment: 'miniflare'
# Remove compatibility_flags from wrangler.jsonc
```

## Resources

- [Wrangler 4 Documentation](https://developers.cloudflare.com/workers/wrangler/)
- [Miniflare v4 Guide](https://miniflare.dev/get-started/migrating)
- [Vitest Pool Workers](https://github.com/cloudflare/workers-sdk/tree/main/packages/vitest-pool-workers)
