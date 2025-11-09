# ADR-0002: Auth Approach - Custom Implementation vs Better Auth

**Status**: ACCEPTED
**Date**: 2025-01-09
**Categories**: [API, SECURITY, AUTHENTICATION]

## Context

The Canopy API implements a SCITT (Supply Chain Integrity,
Transparency, and Trust) transparency service following the SCRAPI
specification. SCITT defines a two-layer authentication model:

1. **Client Authentication**: Verifying who is submitting statements to
   the transparency log (API-level)
2. **Statement Signature Verification**: Cryptographically verifying
   the issuer's signature on statements (COSE Sign1)

The current implementation has stub API key authentication
(`src/scrapi/auth.ts`) that always returns true, and basic COSE Sign1
structure validation in the registration handler.

**Key Question**: Should we adopt the Better Auth framework for
authentication, or implement custom authentication logic tailored to
SCITT requirements?

## Decision

**We will implement custom authentication logic rather than adopting
Better Auth.**

Canopy's authentication requirements are fundamentally different from
Better Auth's design focus. We need:
- Machine-to-machine API key authentication
- COSE Sign1 cryptographic signature verification
- Stateless, token-based auth without sessions
- Minimal overhead for high-throughput transparency log operations

Better Auth is designed for user-centric authentication (sessions,
OAuth flows, 2FA, SSO) which is orthogonal to SCITT's requirements.

## Consequences

### Positive

1. **Purpose-Built**: Authentication logic precisely matches
   SCITT/SCRAPI requirements
2. **Minimal Dependencies**: No additional framework dependencies or
   database requirements
3. **Performance**: Direct implementation without framework abstraction
   overhead
4. **Cryptographic Focus**: Natural integration with COSE signature
   verification
5. **Stateless Design**: No session management complexity, pure
   token/signature validation
6. **SCRAPI Compliance**: Direct alignment with specification's
   authentication model
7. **Flexibility**: Full control over authentication policies and
   validation rules

### Negative

1. **Custom Code Maintenance**: Must maintain our own auth logic and
   security practices
2. **Security Burden**: Responsibility for secure key storage, rotation,
   and validation
3. **No Built-in Features**: Missing framework features (rate limiting,
   token refresh, audit logs)
4. **Testing Overhead**: Must write comprehensive security tests
5. **Documentation Required**: Need to document our custom
   authentication approach

### Trade-offs

**Custom Authentication**:
- Direct COSE signature verification
- Simple API key validation
- No user management overhead
- Stateless and fast

**Better Auth Framework**:
- Comprehensive user authentication
- Built-in session management
- OAuth provider integrations
- Database-backed user storage
- Not designed for COSE/cryptographic signatures
- Overhead for features we don't need

## Implementation

### Two-Layer Authentication Model

Following SCRAPI's architecture, Canopy implements dual authentication:

#### Layer 1: Client Authentication (API Keys)

```typescript
// src/scrapi/auth.ts - Enhanced implementation

/**
 * API Key format: canopy_<base64url(keyId:secret)>
 * Stored in environment: API_KEYS_SECRET (JSON object mapping
 * keyId -> hash)
 */

export async function validateApiKey(
  apiKey: string | undefined,
  env: Env,
): Promise<{ valid: boolean; keyId?: string; issuerId?: string }> {
  if (!apiKey || !apiKey.startsWith('canopy_')) {
    return { valid: false };
  }

  try {
    // Extract and decode key
    const encoded = apiKey.slice(7); // Remove 'canopy_' prefix
    const decoded = base64UrlDecode(encoded);
    const [keyId, secret] = decoded.split(':');

    // Validate against stored hashes
    const keyHash = await hashApiKey(secret);
    const storedKeys = JSON.parse(env.API_KEYS_SECRET || '{}');

    if (storedKeys[keyId] === keyHash) {
      return {
        valid: true,
        keyId,
        issuerId: storedKeys[keyId].issuerId, // Optional
      };
    }
  } catch (error) {
    console.error('[AUTH] API key validation error:', error);
  }

  return { valid: false };
}

async function hashApiKey(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hash);
}
```

#### Layer 2: Statement Signature Verification (COSE Sign1)

```typescript
// src/scrapi/cose-verify.ts - New module

import { decode } from 'cbor-x';

/**
 * Verify COSE Sign1 signature on a signed statement
 */
export async function verifyCoseSign1(
  signedStatement: Uint8Array,
  trustedIssuers?: Set<string>,
): Promise<{ valid: boolean; issuer?: string; payload?: any }> {
  try {
    // Decode COSE_Sign1 structure: [protected, unprotected, payload,
    // signature]
    const [protectedHeader, unprotectedHeader, payload, signature] =
      decode(signedStatement);

    // Decode protected header
    const protected = decode(protectedHeader);
    const algorithm = protected[1]; // alg parameter
    const kid = protected[4]; // kid parameter (issuer key ID)

    // Validate algorithm is supported
    if (!isSignatureAlgorithmSupported(algorithmToString(algorithm))) {
      return { valid: false };
    }

    // Optionally check against trusted issuers
    if (trustedIssuers && !trustedIssuers.has(kid)) {
      return { valid: false };
    }

    // Construct Sig_structure for verification (RFC 9052)
    const sigStructure = constructSigStructure(
      protectedHeader,
      payload,
      'Signature1',
    );

    // Verify signature using Web Crypto API
    const publicKey = await resolveIssuerPublicKey(kid);
    const valid = await crypto.subtle.verify(
      algorithmToCryptoParams(algorithm),
      publicKey,
      signature,
      sigStructure,
    );

    return {
      valid,
      issuer: kid,
      payload: payload ? decode(payload) : undefined,
    };
  } catch (error) {
    console.error('[COSE] Verification error:', error);
    return { valid: false };
  }
}
```

### Authentication Flow

```typescript
// src/index.ts - Updated routing with auth

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // Public endpoints (no auth required)
    const publicPaths = [
      '/api/health',
      '/.well-known/scitt-configuration'
    ];
    if (publicPaths.includes(url.pathname)) {
      return handlePublicEndpoint(request, env);
    }

    // Layer 1: Validate API key
    const authHeader = request.headers.get('authorization');
    const apiKey = extractApiKey(authHeader);
    const authResult = await validateApiKey(apiKey, env);

    if (!authResult.valid) {
      return ClientErrors.unauthorized('Invalid or missing API key');
    }

    // Route to handlers (Layer 2 validation happens in register
    // handler)
    if (request.method === 'POST' &&
        matchesPath(url.pathname, '/logs/:logId/entries')) {
      // Layer 2: COSE signature verification happens in
      // registerSignedStatement
      return await registerSignedStatement(
        request,
        getLogId(url.pathname),
        env
      );
    }

    // ...other routes
  }
};
```

### Security Considerations

1. **API Key Storage**: Keys stored as SHA-256 hashes in environment
   variables
2. **Key Rotation**: Support keyId versioning for graceful rotation
3. **Rate Limiting**: Implement per-key rate limits using Durable
   Objects or KV
4. **Audit Logging**: Log authentication failures and suspicious
   patterns
5. **COSE Verification**: Full RFC 9052 compliance for signature
   verification
6. **Issuer Trust**: Configurable trusted issuer allowlist
7. **Algorithm Allowlist**: Only accept algorithms in transparency
   configuration

### Future Enhancements

- **Rate Limiting**: Per-key request limits using Cloudflare Rate
  Limiting API
- **Key Management UI**: Admin interface for key creation/revocation
- **Issuer Registry**: DID-based issuer resolution (did:web, did:key)
- **Webhook Signatures**: HMAC signatures for R2 event notifications
- **mTLS Support**: Certificate-based client authentication option

## Alternative Considered

### Option: Adopt Better Auth Framework

**Description**: Use Better Auth as the authentication layer for Canopy
API.

```typescript
import { betterAuth } from 'better-auth';

const auth = betterAuth({
  database: env.D1_DATABASE,
  // Configure for API key-like tokens?
});

// Middleware for routes
app.use('*', async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.headers
  });
  if (!session) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
});
```

**Rejected Because**:

1. **Mismatched Paradigm**: Better Auth is designed for user sessions,
   not machine-to-machine API keys
   - Expects browser-based OAuth flows, cookies, session management
   - SCITT clients are machines (CI/CD systems, supply chain tools),
     not users

2. **No COSE Support**: Better Auth doesn't handle cryptographic
   signature verification
   - COSE Sign1 verification is core to SCITT's trust model
   - Would still need custom COSE implementation alongside Better Auth
   - Two auth systems: Better Auth for clients + custom COSE for
     statements

3. **Database Dependency**: Better Auth requires persistent storage
   (D1, PostgreSQL)
   - Adds operational complexity (migrations, backups)
   - Canopy is stateless by design (R2 + Queues only)
   - API keys can be stored as simple environment hashes

4. **Performance Overhead**: Database queries for session validation on
   every request
   - Transparency logs are high-throughput (thousands of
     statements/sec)
   - Stateless API key validation is faster (no DB round-trip)

5. **Feature Bloat**: Paying bundle size cost for unused features
   - 2FA, OAuth providers, password reset flows, email verification
   - None of these apply to machine-to-machine authentication

6. **SCRAPI Specification Mismatch**: SCRAPI allows flexible
   authentication
   - Specification recommends OAuth 2.0 but doesn't mandate framework
   - Simple bearer tokens sufficient for transparency service clients
   - Better Auth's complexity exceeds specification requirements

**When Better Auth Would Make Sense**:
- Building a user-facing dashboard for Canopy management
- Adding multi-tenant organization management with SSO
- Implementing admin panel with 2FA requirements
- User-driven transparency log browsing interface

For these use cases, Better Auth would be added as a separate
authentication layer for the management UI, while keeping custom auth
for the SCRAPI endpoints.

## References

- `packages/apps/canopy-api/src/scrapi/auth.ts`: Current stub
  implementation
- `packages/apps/canopy-api/src/scrapi/register-signed-statement.ts`:
  COSE Sign1 structure validation
- `packages/apps/canopy-api/src/scrapi/transparency-configuration.ts`:
  Supported signature algorithms
- [SCRAPI Specification (draft-05)](https://datatracker.ietf.org/doc/
  draft-ietf-scitt-scrapi/): Authentication model
- [RFC 9052: COSE Structures](https://datatracker.ietf.org/doc/html/
  rfc9052): COSE Sign1 format
- [Better Auth Documentation](https://www.better-auth.com/docs/
  introduction): Framework overview
- [ADR-0001](./adr-0001-raw-request-processing.md): Related decision on
  framework minimalism
