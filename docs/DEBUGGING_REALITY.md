# Actual Debugging with Wrangler v4 and Workerd

## The Reality

Workerd (Cloudflare Workers runtime) **does not support traditional VSCode breakpoints**. This is a fundamental limitation because Workerd uses a different JavaScript runtime than Node.js.

When you attach VSCode to port 9229:
- The connection succeeds
- But breakpoints turn gray (unverified)
- They never get hit

This is because Workerd implements the Chrome DevTools Protocol differently than Node.js.

## Working Debugging Methods

### Method 1: Console Logging (Recommended)

The most reliable way to debug Cloudflare Workers:

```typescript
// In src/routes/api/health/+server.ts
export const GET: RequestHandler = async ({ platform }) => {
  console.log('Health endpoint called');
  console.log('Platform env:', platform?.env);

  const env = platform?.env || {};
  console.log('Environment variables:', {
    canopyId: env.CANOPY_ID,
    forestProjectId: env.FOREST_PROJECT_ID
  });

  // Your code here
};
```

View logs in your terminal where `pnpm dev` is running.

### Method 2: Wrangler Tail (Production Debugging)

For deployed workers:
```bash
wrangler tail --format pretty
```

### Method 3: Return Debug Info in Development

```typescript
export const GET: RequestHandler = async ({ request, platform }) => {
  const debugInfo = {
    headers: Object.fromEntries(request.headers),
    url: request.url,
    env: platform?.env,
    // Add whatever you need to debug
  };

  if (platform?.env?.NODE_ENV === 'development') {
    return json({
      debug: debugInfo,
      // Your normal response
    });
  }

  // Production response without debug info
};
```

### Method 4: Use Chrome DevTools (Limited Success)

1. Start dev server: `pnpm dev`
2. Open Chrome: `chrome://inspect`
3. Click "inspect" on the Remote Target
4. Use the Console tab (Sources tab breakpoints may not work)

## Why VSCode Breakpoints Don't Work

1. **Different Runtime**: Workerd is not Node.js - it's a custom V8-based runtime
2. **Source Map Issues**: The transpiled code structure doesn't map correctly
3. **Protocol Differences**: Workerd's inspector implementation differs from Node.js

## Best Practice Workflow

1. **Use console.log liberally during development**
   ```typescript
   console.log('=== DEBUG: Function start ===');
   console.log('Input:', { logId, fenceIndex });
   ```

2. **Create a debug utility**:
   ```typescript
   // src/lib/debug.ts
   export function debug(label: string, data?: any) {
     if (process.env.NODE_ENV === 'development') {
       console.log(`[DEBUG ${new Date().toISOString()}] ${label}`, data || '');
     }
   }
   ```

3. **Use structured logging**:
   ```typescript
   import { debug } from '$lib/debug';

   debug('API Request', {
     method: request.method,
     url: request.url,
     headers: Object.fromEntries(request.headers)
   });
   ```

## Alternative: Use Miniflare Directly

For unit testing with breakpoints, use Miniflare in your tests:

```typescript
// In test files, breakpoints work!
import { describe, it, expect } from 'vitest';

describe('My test', () => {
  it('can be debugged', () => {
    // Set breakpoint here - it works in tests!
    const result = myFunction();
    expect(result).toBe(expected);
  });
});
```

Run with: `pnpm test:unit`

## Summary

- **Don't rely on VSCode breakpoints** for Cloudflare Workers development
- **Use console.log** as your primary debugging tool
- **Breakpoints work in tests** but not in the running worker
- This is a **known limitation** of the Cloudflare Workers platform
- Chrome DevTools *might* work but is unreliable