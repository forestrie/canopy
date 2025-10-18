# Debugging Quick Start

## TL;DR

1. Run: `pnpm dev`
2. Open Chrome: `chrome://inspect`
3. Click: **"inspect"** on your worker
4. Use: **Console tab** for all debugging

## Chrome DevTools Setup (One-Time)

1. Open `chrome://inspect` in Chrome
2. Click "Configure..." button
3. Add `localhost:9229` if not present
4. Click "Done"

## Every Time You Debug

1. **Terminal 1**: Run `pnpm dev`
2. **Chrome**: Go to `chrome://inspect` → click "inspect"
3. **Add logs** to your code:
   ```typescript
   console.log('Debug:', { variable1, variable2 });
   ```
4. **Make request**: `curl http://localhost:8788/your/endpoint`
5. **Watch Console** in DevTools for output

## Best Console Methods

```typescript
// Basic logging
console.log('Message', data);

// Grouping
console.group('Request Handler');
console.log('Step 1');
console.log('Step 2');
console.groupEnd();

// Tables for objects
console.table({ logId: 'abc', index: 0 });

// Timing
console.time('operation');
// ... code ...
console.timeEnd('operation');

// Warnings and errors
console.warn('Warning!');
console.error('Error!', error);
console.trace(); // Stack trace
```

## Process Management

```bash
# Check what's running
task wrangler:workerd:status

# Kill all workers
task wrangler:workerd:kill

# Start fresh
task wrangler:workerd:restart
```

## Common Issues

### No Remote Target in chrome://inspect
- Ensure `pnpm dev` is running
- Wait a few seconds after start
- Refresh chrome://inspect page

### Console Not Showing Logs
- Check you clicked "inspect" on the correct target
- Ensure your code has `console.log` statements
- Try refreshing DevTools

### Need to Restart
```bash
task wrangler:workerd:kill
pnpm dev
# Reconnect Chrome DevTools
```

## Key Limitations

- **VSCode breakpoints don't work** - use console.log
- **Source maps unreliable** - you'll see bundled code
- **Console tab works great** - this is your main tool

## Full Documentation

- `CHROME_DEVTOOLS_DEBUGGING.md` - Complete Chrome DevTools guide
- `DEBUGGING_REALITY.md` - Why VSCode breakpoints don't work
- `DEBUGGING.md` - All debugging methods