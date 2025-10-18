# Testing Setup Guide

## Vitest Configuration for Cloudflare Workers

The project uses Vitest with Miniflare for testing Cloudflare Workers functionality including R2 storage.

### Configuration Files

We use two separate Vitest configurations:

1. **`vitest.config.ts`** - For integration tests with SvelteKit
2. **`vitest.unit.config.ts`** - For unit tests with Miniflare/R2 mocking

### Why Two Configurations?

- The SvelteKit plugin can conflict with Miniflare environment setup
- Unit tests need Miniflare for R2 mocking
- Integration tests need SvelteKit for route testing

## Running Tests

### Unit Tests (with R2 mocking)

```bash
# Run all unit tests
pnpm test:unit

# Run specific test file
pnpm test:unit src/lib/server/r2.test.ts

# Run with coverage
pnpm test:coverage
```

### Integration Tests

```bash
# Run compliance tests
pnpm test:compliance

# Run E2E tests (from project root)
pnpm test:e2e
```

## Writing Tests for R2 Operations

### Using Mock R2 Bucket

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { storeLeaf } from '$lib/server/r2';
import { createMockR2Bucket } from '$lib/test-helpers/r2-mock';
import type { R2Bucket } from '@cloudflare/workers-types';

describe('My R2 Tests', () => {
  let mockBucket: R2Bucket;

  beforeEach(() => {
    mockBucket = createMockR2Bucket();
  });

  it('should store data in R2', async () => {
    const result = await storeLeaf(
      mockBucket,
      'test-log',
      0,
      new ArrayBuffer(10),
      'application/cbor'
    );

    expect(result).toHaveProperty('path');
    expect(mockBucket.put).toHaveBeenCalled();
  });
});
```

### Using Mock Platform

For testing route handlers that need the full platform context:

```typescript
import { createMockPlatform } from '$lib/test-helpers/r2-mock';

it('should handle request with platform', async () => {
  const platform = createMockPlatform();

  const response = await GET({
    params: { entryId: 'test-123' },
    platform,
    // ... other handler args
  });

  expect(response.status).toBe(200);
});
```

## Miniflare Environment

The `vitest.unit.config.ts` configures Miniflare with:

- **R2 Buckets**: In-memory R2 storage for testing
- **Environment Bindings**: Test environment variables
- **Compatibility Date**: Matches production settings
- **Node.js Compatibility**: Enabled for libraries like `spark-md5`

### Environment Options

```typescript
environmentOptions: {
  bindings: {
    CANOPY_ID: 'canopy-test',
    FOREST_PROJECT_ID: 'forest-test',
    API_VERSION: 'v1',
    NODE_ENV: 'test'
  },
  r2Buckets: ['R2'],
  r2Persist: false, // In-memory for tests
  compatibilityDate: '2024-10-01',
  compatibilityFlags: ['nodejs_compat']
}
```

## Common Testing Patterns

### Testing ArrayBuffer/Uint8Array Handling

```typescript
it('should handle ArrayBuffer serialization', async () => {
  const buffer = new ArrayBuffer(10);
  const view = new Uint8Array(buffer);
  view.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  const result = await storeLeaf(mockBucket, 'log', 0, buffer);

  // Verify Uint8Array conversion happened
  const putCall = (mockBucket.put as any).mock.calls[0];
  expect(putCall[1]).toBeInstanceOf(Uint8Array);
});
```

### Testing with CBOR Data

```typescript
import { encode, decode } from 'cbor-x';

it('should handle CBOR encoding', async () => {
  const data = { test: 'value' };
  const encoded = encode(data);

  const result = await storeLeaf(
    mockBucket,
    'log',
    0,
    encoded.buffer,
    'application/cbor'
  );

  expect(result.hash).toBeTruthy();
});
```

## Troubleshooting

### Error: "Cannot convert undefined or null to object"

This happens when SvelteKit plugin conflicts with test setup. Use `vitest.unit.config.ts` for unit tests.

### Error: "Platform services not available"

Make sure you're using `createMockPlatform()` in tests or running with proper Miniflare configuration.

### Miniflare v4 Configuration

The project uses Miniflare v4 with the `@cloudflare/vitest-pool-workers` package for improved performance and compatibility with Wrangler 4.

Key improvements in v4:
- Better performance with worker pools
- Improved compatibility with Cloudflare Workers runtime
- Native support for R2, KV, and other bindings
- Direct integration with wrangler.jsonc configuration

## Best Practices

1. **Use Mock Helpers**: Always use `createMockR2Bucket()` and `createMockPlatform()` for consistent mocking
2. **Test Both Paths**: Test both success and error cases
3. **Verify R2 Calls**: Use `expect(mockBucket.put).toHaveBeenCalledWith(...)` to verify R2 operations
4. **Clean State**: Use `beforeEach()` to reset mocks between tests
5. **Type Safety**: Import types from `@cloudflare/workers-types` for proper typing
