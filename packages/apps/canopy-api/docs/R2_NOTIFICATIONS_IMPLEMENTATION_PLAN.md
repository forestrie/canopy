# R2 Event Notifications Implementation Plan

## Executive Summary

This document outlines the plan to replace the explicit queue message sending with Cloudflare R2's built-in event notifications feature. When objects are written to R2, R2 will automatically send messages to the queue, eliminating the need for explicit `rangerQueue.send()` calls in the registration handler.

**This is a green field deployment** - no zero-downtime migration needed. We'll implement Option A: Ranger consumes R2 notification format directly.

## Current Architecture

Currently, the flow is:
1. Client POSTs statement to `/logs/{logId}/entries`
2. Canopy Worker:
   - Validates and stores statement in R2 (`storeLeaf()`)
   - Explicitly sends a `LeafRegistrationMessage` to `RANGER_QUEUE`
   - Returns 303 See Other response
3. Ranger service pulls messages from queue and processes them

**Current Message Format** (`LeafRegistrationMessage`):
```typescript
{
  logId: string;
  fenceIndex: number;
  path: string;
  hash: string;
  etag: string;
  timestamp: string;
  canopyId: string;
  forestProjectId: string;
}
```

## Proposed Architecture (Option A - Direct Consumption)

With R2 notifications enabled:
1. Client POSTs statement to `/logs/{logId}/entries`
2. Canopy Worker:
   - Validates and stores statement in R2 (`storeLeaf()`)
   - Returns 303 See Other response
   - **No explicit queue send required**
3. R2 automatically sends notification to queue when object is created
4. Ranger service pulls messages from queue and processes R2 notification format directly

## R2 Notification Message Format

Based on Cloudflare documentation, R2 event notifications to queues include:
```json
{
  "account": "your-account-id",
  "action": "PutObject",
  "bucket": "bucket-name",
  "object": {
    "key": "object-key",
    "size": 12345,
    "eTag": "object-etag"
  },
  "eventTime": "2024-01-01T00:00:00Z"
}
```

**Key Points:**
- `object.key` contains the full path: `logs/{logId}/leaves/{fenceIndex}/{hash}`
- `object.eTag` is the R2-provided ETag (currently MD5, but we'll switch to SHA256)
- `object.size` is the object size in bytes
- Custom metadata is **NOT included** in the notification payload
- Ranger will need to read the R2 object to access custom metadata if needed

## Chosen Approach: Option A (Direct Consumption)

**Rationale:**
- Green field deployment allows for clean implementation
- Simpler architecture (no transformation layer)
- Lower latency (direct path from R2 → Queue → Ranger)
- Ranger can parse object key to extract `logId` and `fenceIndex`
- Custom metadata can be read from R2 object if needed (with minimal performance impact)

### Implementation Steps

#### Step 1: Switch from MD5 to SHA256 Hash

**Rationale:**
- SHA256 is cryptographically stronger (though MD5 is only used for content addressing, not security)
- Better alignment with transparency log practices (SHA256 is standard)
- The configured hash algorithm for the log will be the content hash used for the path
- Hash in path is authoritative - Ranger can verify by reading and computing if needed

**Changes Required in `src/cf/r2.ts`:**

1. Replace MD5 calculation with SHA256:
   - Remove `spark-md5` dependency
   - Use Web Crypto API for SHA256 (available in Cloudflare Workers)
   - Update hash function to return SHA256 hex (64 characters)

2. Update `storeLeaf()` function:
   - Remove `md5: hash` option (R2's md5 expects MD5 format, we're using SHA256)
   - **Do NOT store hash in custom metadata** - path is authoritative
   - Update path building to use SHA256 hash (64 hex chars vs 32 for MD5)
   - Remove `contentHash` from `customMetadata` if present

3. Update `buildLeafPath()`:
   - Ensure it works with 64-character hash (should already work)
   - Path format: `logs/{logId}/leaves/{fenceIndex}/{sha256hash}`

**Architectural Decision:**
- Hash in path is the source of truth
- Ranger trusts the hash in the path, or can read the object and compute SHA256 to verify
- No redundancy - simpler, more maintainable

**Performance Consideration:**
- SHA256 calculation: ~same performance as MD5 in Workers (both use Web Crypto API)
- Path length: 64 chars vs 32 chars - negligible impact

#### Step 2: Configure R2 Event Notifications

**✅ AUTOMATED** - This is now handled automatically by the bootstrap process!

**Automated Configuration:**

The R2 event notifications are automatically configured when running:

- **GitHub Actions**: `Cloudflare Infrastructure` workflow with `action: apply`
- **Local Taskfile**: `task cloudflare:bootstrap`

Both methods will:
1. Create the R2 bucket (if it doesn't exist)
2. Create the queue (if it doesn't exist)
3. **Automatically configure R2 event notifications** from bucket to queue
   - Event type: `object-create`
   - Prefix filter: `logs/`
   - Target queue: `{canopy-id}-ranger`

**Manual Configuration (if needed):**

If automation fails or you need to configure manually:

```bash
# Via Wrangler CLI
npx wrangler r2 bucket notification create \
  canopy-dev-1-leaves \
  --event-type object-create \
  --queue canopy-dev-1-ranger \
  --prefix "logs/"

# Or via Cloudflare Dashboard:
# 1. Navigate to R2 → Bucket → Settings
# 2. Event notifications → Add notification
# 3. Queue: `canopy-dev-1-ranger` (use existing queue)
# 4. Event type: Object creation
# 5. Prefix filter: `logs/`
```

**Checking Notification Status:**

```bash
# Via Taskfile
task cloudflare:status

# Via GitHub Actions
# Run workflow with action: status

# Via Wrangler CLI
wrangler r2 bucket notification list canopy-dev-1-leaves
```

#### Step 3: Update Ranger Service to Consume R2 Notification Format

**Changes Required in `arbor/services/ranger/consumer.go`:**

1. Define R2 notification message structure:
```go
// R2Notification represents the message format from R2 event notifications
type R2Notification struct {
	Account   string      `json:"account"`
	Action    string      `json:"action"`
	Bucket    string      `json:"bucket"`
	Object    R2Object    `json:"object"`
	EventTime string      `json:"eventTime"`
}

type R2Object struct {
	Key   string `json:"key"`
	Size  int64  `json:"size"`
	ETag  string `json:"eTag"`
}
```

2. Update `ProcessMessage()` to parse R2 notification:
   - Parse `R2Notification` from message body
   - Extract `logId` and `fenceIndex` from `object.key` path: `logs/{logId}/leaves/{fenceIndex}/{hash}`
   - Extract `hash` (SHA256) from path (last segment after fenceIndex)
   - Use `object.eTag` as the ETag
   - Use `eventTime` as timestamp
   - **Note**: `canopyId` and `forestProjectId` come from Ranger deployment configuration, not message

3. Read R2 object if verification needed:
   - Optional: Read object to compute SHA256 and verify against hash in path
   - Configure R2 read access (see Step 4)
   - Performance: Single R2 GET request per message (only if verification needed)

#### Step 4: Configure Ranger R2 Access

**R2 Read-Only Access for Ranger:**

Since the R2 bucket is content-addressed and contains public transparency data, we'll start with a public bucket.

**Public R2 Bucket Approach:**
- Make R2 bucket publicly readable
- Ranger reads directly via public URLs
- Format: `https://<account-id>.r2.cloudflarestorage.com/<bucket-name>/<object-key>`
- No authentication needed
- Can add rate limiting proxy later if needed

**Cost Assessment for Public Bucket Abuse:**

**R2 Egress Pricing (as of 2024):**
- First 10 GB per month: **FREE** (included in R2 storage plan)
- Additional egress: **$0.09 per GB**
- Storage: **$0.015 per GB/month**
- Class A operations (writes): **$4.50 per million**
- Class B operations (reads, list): **$0.36 per million**

**Abuse Scenarios & Costs:**

1. **Normal Operations:**
   - Ranger reads each object once: ~100KB per object
   - 10,000 objects/month = ~1 GB egress = **$0** (within free tier)

2. **Malicious Bulk Download:**
   - Attacker downloads entire bucket: e.g., 100 GB
   - Cost: (100 GB - 10 GB free) × $0.09 = **$8.10**
   - **Mitigation**: Content-addressed storage means objects rarely change, can cache aggressively

3. **Repeated Requests (DDoS-style):**
   - Attacker requests same object repeatedly: 1 million reads
   - Class B operations: 1M × $0.36/M = **$0.36**
   - **Mitigation**: 
     - Cloudflare CDN can cache objects (immutable cache headers)
     - Rate limiting at Cloudflare level
     - CORS restrictions if needed

4. **Worst Case (Multiple Attackers, Full Bucket):**
   - 10 attackers, each downloading 100 GB/month
   - Total: 1 TB egress = (1000 GB - 10 GB free) × $0.09 = **$89.10/month**
   - **Mitigation**: 
     - Monitor egress usage in Cloudflare dashboard
     - Set up billing alerts
     - Add rate limiting proxy if costs become significant
     - Consider Cloudflare Access or token-based auth if abuse persists

**Recommendation:**
- Start with public bucket (costs likely minimal for transparency log use case)
- Monitor egress usage in first few months
- Set billing alerts at $10, $50, $100 thresholds
- Add rate limiting proxy if egress exceeds $20-30/month unexpectedly
- Content-addressed nature + caching means most reads should hit cache

**Configuration in Ranger:**
Add to `config.go`:
```go
type Config struct {
	// ... existing fields ...
	
	// R2 Access Configuration (public bucket approach)
	R2BucketName    string // e.g., "canopy-dev-1-leaves"
	R2AccountID     string // Cloudflare account ID
	R2PublicURL     string // Public R2 URL template
	
	// Deployment configuration (not from messages)
	CanopyID        string // e.g., "canopy-dev-1"
	ForestProjectID string // e.g., "forest-dev-1"
}
```

#### Step 5: Remove Explicit Queue Send from Canopy API

**Update `src/scrapi/register-signed-statement.ts`:**
- Remove `rangerQueue: Queue` parameter
- Remove `createLeafRegistrationMessage` import
- Remove queue send logic (lines 91-114)
- Keep error handling for R2 storage failures

**Simplified function signature:**
```typescript
export async function registerSignedStatement(
  request: Request,
  logId: string,
  r2Bucket: R2Bucket,
  canopyId?: string,
  forestProjectId?: string
): Promise<Response>
```

#### Step 6: Update Wrangler Configuration

**Remove queue producer from `canopy-api/wrangler.jsonc`:**
```json
{
  "name": "canopy-api",
  // ... other config ...
  // Remove this section:
  // "queues": {
  //   "producers": [...]
  // }
}
```

#### Step 7: Update Worker Bindings

**Remove from `src/index.ts` Env interface:**
```typescript
export interface Env {
  R2: R2Bucket;
  // RANGER_QUEUE: Queue;  // Remove this - no longer needed
  CANOPY_ID: string;
  FOREST_PROJECT_ID: string;
  API_VERSION: string;
  NODE_ENV: string;
}
```

**Update function call:**
```typescript
const response = await registerSignedStatement(
  request,
  segments[1],
  env.R2,
  // env.RANGER_QUEUE,  // Remove this
  env.CANOPY_ID,
  env.FOREST_PROJECT_ID
);
```

## Implementation Sequence

Since this is a green field deployment, we can implement in any order. Recommended sequence:

### Phase 1: Update Hash Algorithm (SHA256)
1. Update `r2.ts` to use SHA256 instead of MD5
2. Update tests
3. Deploy and validate

### Phase 2: Configure R2 Notifications
1. Configure R2 bucket notifications to send to existing `canopy-dev-1-ranger` queue
2. Test with sample object upload
3. Verify notification format in queue

### Phase 3: Update Ranger
1. Update `consumer.go` to parse R2 notification format
2. Implement path parsing for `logId`, `fenceIndex`, `hash`
3. Configure R2 access (public URL or API token)
4. Test message processing

### Phase 4: Remove Explicit Queue Send
1. Remove queue send logic from `register-signed-statement.ts`
2. Remove queue producer binding from wrangler.jsonc
3. Deploy updated canopy-api
4. Monitor for any issues

## Testing Strategy

### Unit Tests
- Test transformation logic with mock R2 notifications
- Test path parsing for valid/invalid formats
- Test metadata extraction from R2 objects

### Integration Tests
1. Upload object to R2 via canopy-api
2. Verify notification appears in R2 notification queue
3. Verify transformation worker processes it
4. Verify Ranger queue receives correct message format
5. Verify Ranger processes message successfully

### Error Handling Tests
- Missing R2 object (object deleted between notification and read)
- Invalid object path format
- Missing custom metadata
- Queue send failures in transformer

## Open Questions

### 1. Custom Metadata in Notifications
**Question**: Do R2 notifications include `customMetadata` in the payload?
**Current Understanding**: Based on Cloudflare docs, notifications include `account`, `action`, `bucket`, `object.key`, `object.size`, `object.eTag`, `eventTime` - but NOT custom metadata.
**Action Required**: 
- Test with real notification to confirm
- If NOT included: Ranger reads R2 object to get metadata (minor performance impact)
- If INCLUDED: Use it directly (no R2 read needed)
**Impact**: If metadata is included, we can include SHA256 hash in metadata and avoid R2 read

### 2. Performance Impact of Metadata Read
**Question**: If metadata is NOT included, what's the performance impact of Ranger reading R2 object?
**Analysis**:
- Ranger already needs to read object content for processing
- Reading metadata is a HEAD request (or same GET request with metadata)
- Minimal overhead (metadata comes with object GET)
**Recommendation**: Even if metadata read is needed, it's acceptable given Ranger processes the object anyway

### 3. Duplicate Notifications
**Question**: Can R2 send duplicate notifications for the same object?
**Recommendation**: Implement idempotency in Ranger based on object key + etag
**Impact**: Should check if message already processed before processing again

### 4. SHA256 Hash Storage
**Question**: Should SHA256 hash be stored in:
- Path (already planned - part of content addressing)
- Custom metadata (for easy access without parsing path)
- Both (recommended)
**Recommendation**: Store in both for flexibility

### 5. R2 Access Method
**Question**: Public bucket vs API token for Ranger access?
**Recommendation**: Start with public bucket (simpler), add proxy/rate limiting later if needed

## Benefits of This Approach (Option A)

1. **Simpler Architecture**: No transformation layer - direct R2 → Queue → Ranger
2. **Lower Latency**: Fewer hops, faster message delivery
3. **Reliability**: R2 guarantees notifications are sent (no missed messages)
4. **Decoupling**: Canopy API doesn't need to know about queue details
5. **Scalability**: R2 handles notification batching and delivery
6. **Maintainability**: Fewer components to maintain
7. **Native Format**: Ranger consumes Cloudflare's native notification format

## Risks & Mitigations

### Risk 1: Notification Delay
**Concern**: R2 notifications might have slight latency vs explicit send
**Mitigation**: Monitor notification latency, add alerting. Acceptable for transparency log use case.

### Risk 2: Path Parsing Errors
**Concern**: If object path format changes, Ranger parsing fails
**Mitigation**: 
- Robust path parsing with validation
- Clear error messages
- Path format is part of API contract (unlikely to change)

### Risk 3: Missing Metadata
**Concern**: Custom metadata not in notifications
**Mitigation**: 
- Store hash in path (always available)
- Read R2 object if additional metadata needed
- Acceptable performance trade-off

### Risk 4: R2 Access Configuration
**Concern**: Public bucket vs token access decision
**Mitigation**: 
- Start simple (public bucket)
- Can migrate to token-based access later if needed
- Add rate limiting proxy if needed

## Next Steps

1. **✅ Implement SHA256 hash** - Completed: Updated `r2.ts` to calculate SHA256 and use in path (not metadata)
2. **✅ Remove explicit queue send** - Completed: Cleaned up canopy-api code (no fallback needed)
3. **✅ Automate notification configuration** - Completed: Added to bootstrap workflow and taskfile
4. **Test R2 notification format** - Upload test object and inspect queue message to confirm exact JSON structure
5. **Run bootstrap to configure notifications** - Execute `task cloudflare:bootstrap` or GitHub workflow to set up notifications
6. **Update Ranger consumer** - Parse R2 notification format, extract data from path
7. **Configure R2 access for Ranger** - Set up public bucket access
8. **Test end-to-end** - Upload → R2 notification → Queue → Ranger processing

## Decisions Made

1. **SHA256 Hash**: Store SHA256 hash in path only (`logs/{logId}/leaves/{fenceIndex}/{sha256hash}`)
   - Path is authoritative source
   - Ranger can verify by reading object and computing hash if needed
   - No metadata storage of hash

2. **R2 Access for Ranger**: 
   - Start with public bucket (simpler)
   - Monitor egress costs (first 10GB/month free)
   - Add rate limiting proxy later if abuse occurs

3. **Metadata Requirements**: 
   - Ranger extracts `logId`, `fenceIndex`, `hash`, `etag`, `timestamp` from R2 notification
   - `canopyId` and `forestProjectId` from Ranger deployment configuration (not per message)

4. **Error Handling**: 
   - Remove explicit queue send completely (green field allows this)
   - **Note**: Could not find specific Cloudflare recommendation about keeping explicit send as fallback
   - R2 event notifications have 99.9% SLA, same as R2 service overall
   - Focus on robust error handling in Ranger consumer (retries, DLQ, etc.)

## References

- [Cloudflare R2 Event Notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [Cloudflare Queues Documentation](https://developers.cloudflare.com/queues/)
- [R2 Event Notifications Tutorial](https://developers.cloudflare.com/r2/tutorials/upload-logs-event-notifications/)
- [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 Troubleshooting](https://developers.cloudflare.com/r2/platform/troubleshooting/)

## Cloudflare Documentation Review - Error Fallback Recommendation

**Finding**: I could not locate a specific Cloudflare recommendation to keep explicit queue send as a fallback for R2 event notifications.

**What Cloudflare docs say:**
- R2 event notifications documentation focuses on setup and message format
- No explicit guidance on producer-side fallback mechanisms
- Error handling recommendations focus on consumer-side: retries, exponential backoff, dead letter queues
- R2 service has 99.9% SLA (same applies to event notifications as part of R2 service)

**Recommendation for this project:**
- Given green field deployment, remove explicit queue send completely
- Rely on R2 event notifications as primary mechanism
- Implement robust error handling in Ranger consumer:
  - Retry logic with exponential backoff
  - Dead letter queue for failed messages
  - Monitoring and alerting for notification failures
- This approach is simpler and aligns with Cloudflare's event-driven architecture

**If you find specific documentation recommending fallback**, please share and we can update the plan accordingly.

