# `@canopy/api`

## R2 leaf expiry (transient ingress objects)

`canopy-api` stores inbound SCRAPI leaves in the `R2_LEAVES` bucket using a
content-addressed key:

- `logs/<logId>/leaves/<sha256>`

These objects are intended to be **transient** (the content hash is used as the
temporary pre-sequence identifier).

### Why this is not just a `wrangler.jsonc` setting

Cloudflare R2 **object lifecycle rules** are configured **at the bucket level**
(Dashboard/API/CLI), and they are not currently declared inside
`wrangler.jsonc`. They are also not a good fit for **minute-level TTL**.

### What we do instead

We enforce expiry with a **scheduled cleanup sweep**:

- `wrangler.jsonc` sets a cron trigger to run every minute
- The Worker `scheduled()` handler deletes leaf objects older than
  `LEAF_TTL_SECONDS` (default: 300 = 5 minutes)

### Configuration

- `LEAF_TTL_SECONDS`: string, TTL in seconds for leaf objects (default `"300"`).
