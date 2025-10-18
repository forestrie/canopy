# Development Setup Guide

## Running the Development Server

### Default Development Mode (Wrangler with R2)

The default `pnpm dev` command uses Wrangler to ensure full Cloudflare Workers compatibility:

```bash
cd packages/apps/canopy
pnpm dev
```

This will:
- Start Wrangler with the configuration from `wrangler.jsonc`
- Initialize local R2 buckets via Miniflare
- Provide full Workers runtime simulation
- Make the app available at http://localhost:8788
- **All R2 operations will work correctly**

### Alternative: Vite Dev Server (Fast UI Development)

For rapid UI development with hot-module replacement (HMR):

```bash
cd packages/apps/canopy
pnpm dev:vite
```

This will:
- Start the Vite dev server with HMR
- Make the app available at http://localhost:5173
- **Note: R2 operations will NOT work** (platform.env.R2 will be undefined)
- Best for frontend-only changes

### Hybrid Development (Best of Both Worlds)

For UI development with working R2:

**Terminal 1 - API Server:**
```bash
cd packages/apps/canopy
pnpm dev  # Wrangler on :8788
```

**Terminal 2 - UI with HMR:**
```bash
cd packages/apps/canopy
pnpm dev:vite  # Vite on :5173
```

Then configure Vite to proxy API calls to Wrangler (add to vite.config.ts if needed):
```javascript
server: {
  proxy: {
    '/api': 'http://localhost:8788',
    '/entries': 'http://localhost:8788',
    '/operations': 'http://localhost:8788',
    '/.well-known': 'http://localhost:8788'
  }
}
```

## Testing API Endpoints

### With Wrangler Running

Test the SCRAPI endpoints:

```bash
# Test configuration endpoint
curl http://localhost:8788/.well-known/scitt-configuration

# Submit a COSE Sign1 statement
curl -X POST http://localhost:8788/entries \
  -H "Content-Type: application/cose; cose-type=cose-sign1" \
  -H "Authorization: Bearer test-api-key" \
  --data-binary @test-statement.cose
```

### Creating Test Data

Create a test COSE Sign1 file:

```bash
# Create a simple test COSE Sign1 structure
echo -n -e '\x84\x40\xa0\x45\x48\x65\x6c\x6c\x6f\x40' > test-statement.cose
```

This creates a minimal COSE Sign1 with:
- Protected headers: empty
- Unprotected headers: empty
- Payload: "Hello"
- Signature: empty

## Troubleshooting

### Error: "false == true" from Miniflare

This is a serialization issue with ArrayBuffer/Uint8Array in Miniflare. The fix has been applied to:
- Convert ArrayBuffer to Uint8Array before R2 operations
- Use spark-md5 for MD5 hashing (compatible with Workers runtime)

### Error: "Platform services not available"

This means the R2 binding is not initialized. Make sure you're running with Wrangler:
```bash
pnpm dev:wrangler
```

### Error: "Cannot find module 'spark-md5'"

Install the required dependency:
```bash
pnpm add spark-md5
pnpm add -D @types/spark-md5
```

## Environment Variables

The application uses these environment variables (set in wrangler.jsonc):

- `CANOPY_ID`: Instance identifier (default: "canopy-dev-1")
- `FOREST_PROJECT_ID`: External forest project reference
- `API_VERSION`: API version (default: "v1")
- `NODE_ENV`: Environment mode

## R2 Bucket Configuration

The R2 bucket is configured in `wrangler.jsonc`:

```json
"r2_buckets": [
  {
    "binding": "R2",
    "bucket_name": "canopy-dev-1-leaves"
  }
]
```

For local development, Wrangler will create a local simulation of this bucket.

## Next Steps

1. Ensure you have Cloudflare credentials configured:
   ```bash
   wrangler login
   ```

2. Create the R2 bucket if it doesn't exist:
   ```bash
   wrangler r2 bucket create canopy-dev-1-leaves
   ```

3. Start development:
   ```bash
   pnpm dev:wrangler
   ```