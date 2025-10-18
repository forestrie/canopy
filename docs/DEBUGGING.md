# Debugging Guide for Wrangler v4

## Overview

This project uses Wrangler v4 with Cloudflare Workers (Workerd runtime). The inspector is automatically enabled on port 9229 when running the dev server.

## Process Management

### Check Process Status
```bash
task wrangler:workerd:status
```
Shows running workerd/wrangler processes and port status.

### Clean Up Processes
```bash
task wrangler:workerd:kill
```
Gracefully stops all workerd and wrangler processes.

### Start Fresh Dev Server
```bash
# Option 1: Start normally
pnpm dev

# Option 2: Kill old processes and start fresh
task wrangler:workerd:restart

# Option 3: Using task command
task wrangler:dev
```

## Debugging with VSCode

**Important**: VSCode breakpoints do not work reliably with Cloudflare Workers (Workerd runtime). See `DEBUGGING_REALITY.md` for details.

**For actual debugging, use Chrome DevTools** (see below) or console.log statements.

## Debugging with Chrome DevTools (Recommended)

### Quick Start

1. **Start the dev server:**
   ```bash
   pnpm dev
   ```
   Wait for: `Ready on http://localhost:8788`

2. **Open Chrome DevTools:**
   - Open Chrome browser
   - Navigate to: `chrome://inspect`
   - First time: Click "Configure..." and add `localhost:9229` if not present
   - Look for "Remote Target" section
   - Click **"inspect"** on your worker

3. **Use the Console Tab:**
   - The Console tab shows all `console.log` output in real-time
   - This is your primary debugging interface
   - Sources tab breakpoints are unreliable

### Detailed Guide

See `CHROME_DEVTOOLS_DEBUGGING.md` for comprehensive instructions including:
- First-time setup
- Console debugging techniques
- Using console.group, console.table, console.time
- Interactive object inspection
- Troubleshooting tips

## Setting Breakpoints

You can set breakpoints in:
- Route handlers: `src/routes/**/+server.ts`
- Server-side page code: `src/routes/**/+page.server.ts`
- Library code: `src/lib/server/**/*.ts`
- SCRAPI implementations: `src/lib/scrapi/**/*.ts`
- Hooks: `src/hooks.server.ts`

## Example: Debugging an API Request

1. Start debugging (using either method above)

2. Set a breakpoint in `src/routes/api/health/+server.ts`:
   ```typescript
   export const GET: RequestHandler = async ({ platform }) => {
     // Set breakpoint on this line
     const env = platform?.env || {};
   ```

3. Make a request:
   ```bash
   curl http://localhost:8788/api/health
   ```

4. The debugger will pause at your breakpoint where you can:
   - Inspect variables in the Variables panel
   - Step through code (F10 for next line, F11 to step into)
   - View the call stack
   - Evaluate expressions in the Debug Console

## Debugging SCRAPI Endpoints

For CBOR endpoints, set breakpoints in the handler and use the debug console to inspect binary data:

```typescript
// In src/routes/entries/+server.ts
export const POST: RequestHandler = async ({ request, platform }) => {
  // Set breakpoint here
  const contentType = request.headers.get('content-type');

  if (isCborContentType(contentType)) {
    const buffer = await request.arrayBuffer();
    // Breakpoint here to inspect the buffer
    const decoded = decode(new Uint8Array(buffer));
    // Breakpoint here to see decoded CBOR
  }
```

## Debug Console Commands

While paused at a breakpoint, you can use the Debug Console to:

```javascript
// Inspect environment variables
platform.env

// Check R2 bucket
platform.env.R2

// Inspect request details
request.url
request.headers

// Test functions
buildLeafPath('test-log', 0, 'abc123')
```

## Troubleshooting

### Debugger won't attach
- Ensure port 9229 is not in use: `lsof -i :9229`
- Kill any existing processes: `pkill -f wrangler`
- Restart VSCode

### Breakpoints show as gray/unverified
- This is normal until the code is loaded
- Make a request to the endpoint to load the module
- The breakpoint should turn red when verified

### Source maps not working
- Ensure you've built recently: `pnpm build`
- Check that `.svelte-kit/cloudflare/_worker.js.map` exists
- Restart the debug session

### Can't see variables
- Some variables may be optimized out in production builds
- Use `console.log` or the Debug Console for complex objects
- Ensure you're debugging the dev build, not production

## Environment Variables in Debug Mode

The debugger has access to all Wrangler bindings:
- `platform.env.R2` - R2 bucket binding
- `platform.env.CANOPY_ID` - Canopy instance ID
- `platform.env.FOREST_PROJECT_ID` - Forest project ID
- `platform.env.API_VERSION` - API version
- `platform.env.NODE_ENV` - Environment mode

## Advanced: Conditional Breakpoints

Right-click on a breakpoint to add conditions:

```javascript
// Only break for specific log IDs
logId === 'test-log-123'

// Break on specific HTTP methods
request.method === 'POST'

// Break on error conditions
response.status >= 400
```

## Using Chrome DevTools

Alternatively, you can debug using Chrome:

1. Start the dev server with debugging:
   ```bash
   pnpm dev:debug
   ```

2. Open Chrome and navigate to:
   ```
   chrome://inspect
   ```

3. Click "Configure" and add `localhost:9229`

4. Click "inspect" under the Remote Target

5. Use Chrome DevTools to debug (similar to client-side debugging)

## Tips

- Use `debugger;` statements in your code as an alternative to clicking breakpoints
- The Debug Console supports top-level await for async operations
- You can modify variable values in the Variables panel during debugging
- Use logpoints (right-click gutter → Add Logpoint) for non-breaking logging