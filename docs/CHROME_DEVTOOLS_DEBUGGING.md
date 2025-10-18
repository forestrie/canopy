# Debugging Cloudflare Workers with Chrome DevTools

## Setup

Your current setup already enables the Chrome DevTools inspector on port 9229 when running `pnpm dev`.

## Step-by-Step Guide

### 1. Start the Dev Server

```bash
pnpm dev
```

Wait for the message:
```
Ready on http://localhost:8788
```

### 2. Open Chrome DevTools

1. Open Google Chrome browser
2. In the address bar, type: `chrome://inspect`
3. Press Enter

### 3. Configure the Connection (First Time Only)

1. On the chrome://inspect page, click **"Configure..."** button (next to "Discover network targets")
2. In the dialog that appears, ensure `localhost:9229` is in the list
3. If not, add it:
   - Type: `localhost:9229`
   - Click "Done"

### 4. Find and Inspect Your Worker

1. Look for a section called **"Remote Target"** on the chrome://inspect page
2. You should see an entry like:
   ```
   Target
   file:///.../canopy/packages/apps/canopy/.svelte-kit/cloudflare/_worker.js
   ```
3. Click the **"inspect"** link below it

### 5. Using Chrome DevTools

A new Chrome DevTools window will open. Here's what works:

#### Console Tab (Works Best)
- The **Console** tab shows all your `console.log` output in real-time
- You can execute JavaScript in the context of your worker
- Try typing: `env.CANOPY_ID` to see environment variables

#### Sources Tab (Limited)
- You may see your bundled worker code
- Setting breakpoints is unreliable - they may or may not work
- Source maps may not load correctly

#### Network Tab
- Doesn't show worker requests (this is a limitation)

### 6. Testing Your Setup

Make a request to trigger logging:
```bash
curl http://localhost:8788/api/health
```

You should see console output appear in the Chrome DevTools Console tab.

## Best Practices

### Add Detailed Console Logging

```typescript
// In your route handlers
export const POST: RequestHandler = async ({ request, platform }) => {
  console.group('POST /entries');
  console.log('Request URL:', request.url);
  console.log('Request method:', request.method);
  console.log('Content-Type:', request.headers.get('content-type'));

  try {
    // Your code here
    console.log('Processing complete');
  } catch (error) {
    console.error('Error occurred:', error);
    console.trace(); // Shows stack trace
  } finally {
    console.groupEnd();
  }

  return response;
};
```

### Use Console Methods

Chrome DevTools supports rich console methods:

```typescript
// Grouping related logs
console.group('Request Processing');
console.log('Step 1');
console.log('Step 2');
console.groupEnd();

// Tables for structured data
console.table({ logId: 'abc', fenceIndex: 0 });

// Timing
console.time('operation');
// ... code ...
console.timeEnd('operation');

// Conditional logging
console.assert(logId, 'logId is required');

// Different log levels
console.log('Info message');
console.warn('Warning message');
console.error('Error message');
console.debug('Debug message');
```

### Inspect Objects

In Chrome DevTools Console, you can inspect objects interactively:

```typescript
// Log the platform object
console.log('Platform:', platform);

// In DevTools Console, you can then type:
// > platform.env.R2
// > platform.env.CANOPY_ID
```

## Troubleshooting

### "No targets found"

If you don't see any Remote Targets:
1. Ensure `pnpm dev` is running
2. Wait a few seconds for it to fully start
3. Refresh the chrome://inspect page
4. Check that port 9229 is configured correctly

### "Connection lost"

If DevTools disconnects:
1. The worker may have crashed - check your terminal
2. You may have restarted the dev server
3. Click "inspect" again to reconnect

### Breakpoints Don't Work

This is expected behavior. Workerd's debugging support is limited:
- Console tab works reliably
- Breakpoints in Sources tab are unreliable
- Use `console.log` instead of relying on breakpoints

### Source Maps Not Loading

Source maps from SvelteKit may not work correctly in Workerd. You'll see bundled code instead of your TypeScript source. This is a known limitation.

## Workflow

1. **Start dev server**: `pnpm dev`
2. **Open Chrome DevTools**: `chrome://inspect` → click "inspect"
3. **Add console.log statements** in your code where you want visibility
4. **Make requests** to trigger your handlers
5. **Watch Console tab** in DevTools for output
6. **Use Console interactively** to inspect objects and test code

## Alternative: Terminal Logs

If Chrome DevTools is inconvenient, your console.log output also appears in the terminal where you ran `pnpm dev`. This is often simpler for quick debugging.

## Summary

- Chrome DevTools **Console tab** is your primary debugging tool
- **Breakpoints don't work reliably** - use console.log instead
- The inspector automatically runs on **port 9229**
- Access it at **chrome://inspect**
- This is the standard debugging experience for Cloudflare Workers