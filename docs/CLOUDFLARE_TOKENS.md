# Cloudflare API Token Configuration

This document explains the API token system used by Canopy for secure access to Cloudflare R2 resources.

## Token Types

### 1. R2_ADMIN - Infrastructure Management Token

**Purpose**: Create, configure, and destroy R2 buckets and infrastructure
**Used by**: Terraform, infrastructure automation
**Required permissions**:
- Account → Cloudflare R2 Storage:Edit (full account access)
- Account → Workers R2 Storage:Edit

**When to use**:
- Running `task cloudflare:bootstrap`
- Running `task cloudflare:destroy`
- Any Terraform operations

**Security**: Never deploy this token to production applications. Keep it restricted to CI/CD and admin operations only.

### 2. R2_WRITER - Application Read/Write Token

**Purpose**: Read and write objects in R2 buckets
**Used by**: Canopy SvelteKit application
**Required permissions**:
- Account → Cloudflare R2 Storage:Edit (scoped to specific buckets)
- Recommended: Scope to `forest-*-canopy` buckets only

**When to use**:
- Production application deployment
- Development with `wrangler dev`
- Vercel deployments

**Security**: This token is deployed with the application but should be scoped to only the necessary buckets.

### 3. R2_READER - Read-Only Token

**Purpose**: Read objects from R2 buckets
**Used by**: External services needing read-only access
**Required permissions**:
- Account → Cloudflare R2 Storage:Read (scoped to specific buckets)

**When to use**:
- Public API endpoints (future)
- Monitoring services
- Analytics tools

**Security**: Safe for wider distribution as it only allows read operations.

### (Removed) Queue tokens

Queue tokens and configuration are not used in the current design.

## Creating Tokens

### Step 1: Navigate to Cloudflare API Tokens

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Go to "My Profile" → "API Tokens"
3. Click "Create Token"

### Step 2: Create R2_ADMIN Token

1. Use "Custom token" template
2. Token name: `canopy-r2-admin`
3. Permissions:
   - Account → Cloudflare R2 Storage → Edit
   - Account → Workers R2 Storage → Edit
4. Account resources: Include → Your account
5. Continue to summary → Create Token

### Step 3: Create R2_WRITER Token

1. Use "Custom token" template
2. Token name: `canopy-r2-writer`
3. Permissions:
   - Account → Cloudflare R2 Storage → Edit
4. Account resources: Include → Your account
5. (Optional) Add IP filtering for production
6. Continue to summary → Create Token

### Step 4: Create R2_READER Token

1. Use "Custom token" template
2. Token name: `canopy-r2-reader`
3. Permissions:
   - Account → Cloudflare R2 Storage → Read
4. Account resources: Include → Your account
5. Continue to summary → Create Token

### Step 5: Create QUEUE_ADMIN Token

1. Use "Custom token" template
2. Token name: `canopy-queue-admin`
3. Permissions:
   - Account → Cloudflare Queues → Edit
4. Account resources: Include → Your account
5. Continue to summary → Create Token

## Configuration

### Local Development

1. Configure environment variables in `.env`:
   ```bash
   CANOPY_ID=canopy-dev-1
   CANOPY_STATE_ID=canopy-dev-1
   FOREST_PROJECT_ID=forest-dev-1  # External project reference
   ```

2. Copy `.env.example.secrets` to `.env.secrets`
3. Add your tokens:
   ```bash
   R2_ADMIN=your_r2_admin_token
   R2_WRITER=your_r2_writer_token
   R2_READER=your_r2_reader_token
   # No queue token required
   ```

3. For Wrangler development, copy `.dev.vars.example` to `.dev.vars`:
   ```bash
   cd packages/apps/canopy
   cp .dev.vars.example .dev.vars
   # Edit .dev.vars and add R2_WRITER token
   ```

### CI/CD Configuration

#### GitHub Actions

Add secrets to your repository:
- `R2_ADMIN` - For infrastructure management workflows
- `QUEUE_ADMIN` - For queue management
- `R2_WRITER` - For application deployment (if deploying from GitHub)

#### Vercel

Add environment variables in Vercel dashboard:
- `r2-writer-token` - The R2_WRITER token value

### Production Deployment

**Important Security Notes**:

1. **Never expose R2_ADMIN in production applications**
2. **Scope tokens to minimum necessary permissions**
3. **Use separate tokens for different environments**
4. **Rotate tokens regularly**
5. **Monitor token usage in Cloudflare Analytics**

## Token Validation

### Check Token Permissions

Use the Cloudflare API to verify token permissions:

```bash
curl -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### Test R2 Access

```bash
# Test R2_ADMIN (list buckets)
curl -X GET "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/r2/buckets" \
  -H "Authorization: Bearer YOUR_R2_ADMIN_TOKEN"

# Test R2_WRITER (list objects - replace bucket name)
curl -X GET "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/r2/buckets/forest-dev-1-canopy/objects" \
  -H "Authorization: Bearer YOUR_R2_WRITER_TOKEN"
```

## Troubleshooting

### Common Issues

1. **"Unauthorized" errors in Terraform**
   - Verify R2_ADMIN token has full R2 Storage:Edit permissions
   - Check token hasn't expired

2. **"Permission denied" in application**
   - Verify R2_WRITER token is correctly set in environment
   - Check token has access to the specific bucket

3. (N/A) Queue operations guidance removed

### Token Rotation

When rotating tokens:

1. Create new token with same permissions
2. Update `.env.secrets` locally
3. Update CI/CD secrets
4. Update Vercel environment variables
5. Test all operations
6. Delete old token from Cloudflare dashboard

## Security Best Practices

1. **Principle of Least Privilege**: Only grant minimum necessary permissions
2. **Environment Separation**: Use different tokens for dev/staging/production
3. **Token Scoping**: Scope tokens to specific resources when possible
4. **Access Logging**: Enable Cloudflare Audit Logs for token usage
5. **Regular Audits**: Review token permissions quarterly
6. **Incident Response**: Have a plan for token compromise

## References

- [Cloudflare API Tokens Documentation](https://developers.cloudflare.com/api/tokens/)
- [R2 API Documentation](https://developers.cloudflare.com/r2/api/)