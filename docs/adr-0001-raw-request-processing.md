# ADR-0001: Raw Request Processing vs Hono Web Framework

**Status**: ACCEPTED
**Date**: 2025-01-09
**Categories**: [API, ARCHITECTURE, PERFORMANCE]

## Context

The Canopy API (`packages/apps/canopy-api`) is a Cloudflare
Workers-based implementation of the SCRAPI (Supply Chain Registration
API) protocol. The API needs to handle HTTP routing, request parsing,
CBOR encoding/decoding, and integration with Cloudflare services (R2,
Queues).

When building APIs on Cloudflare Workers, there are two primary
architectural approaches:

1. **Raw Request Processing**: Direct manipulation of native `Request`
   objects, manual URL parsing, and explicit routing logic
2. **Web Framework (Hono)**: Using a lightweight web framework like
   Hono that provides routing, middleware, and request/response helpers

**Key Question**: Should we continue with raw request processing or
adopt Hono as our web framework?

## Decision

**We will continue using raw request processing for the Canopy API.**

The current implementation directly processes `Request` objects and
manually handles routing using URL pathname parsing. This approach
aligns with the project's minimal dependency philosophy and provides
full control over request/response handling.

## Consequences

### Positive

1. **Zero Framework Overhead**: No additional abstractions or
   middleware layers
2. **Full Control**: Direct access to Cloudflare Workers primitives
   without framework abstractions
3. **Minimal Bundle Size**: Fewer dependencies to bundle and deploy
4. **Predictable Performance**: No framework magic or hidden middleware
   chains
5. **Learning Investment**: Deep understanding of Web Standards
   (Request, Response, URL APIs)
6. **Transparency**: Request flow is explicit and traceable in code

### Negative

1. **Manual Routing**: URL pattern matching and parameter extraction
   must be implemented manually
2. **Code Verbosity**: More boilerplate for common patterns (CORS,
   error handling, response building)
3. **Middleware Patterns**: No built-in middleware system for
   cross-cutting concerns
4. **Type Safety**: Route parameter types must be validated manually
5. **Developer Experience**: Less ergonomic than framework DSLs for
   route definition
6. **Feature Development Speed**: Common web framework features require
   custom implementation

### Trade-offs

**Raw Request Processing**:
- Minimal abstraction, maximum control
- Lower-level code, higher cognitive load for new contributors
- Framework-independent knowledge transferable across runtimes

**Hono Framework**:
- Ergonomic routing DSL with type inference
- Built-in middleware system (CORS, logging, auth)
- More dependencies and bundle size
- Framework-specific knowledge and patterns

## Implementation

### Current Architecture

```typescript
// packages/apps/canopy-api/src/index.ts
export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Manual CORS handling
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      // ...
    };

    // Manual routing
    if (pathname === "/api/health" && request.method === "GET") {
      return Response.json(
        { status: "healthy" },
        { headers: corsHeaders }
      );
    }

    // Manual path segment parsing
    const segments = pathname.split("/").slice(1);

    if (segments[0] !== "logs" || segments[2] !== "entries") {
      return problemResponse(
        404,
        "Not Found",
        "...",
        corsHeaders
      );
    }

    // Route handlers
    if (request.method === "POST") {
      return await registerSignedStatement(
        request,
        segments[1],
        env.R2
      );
    }
    // ...
  }
};
```

### Patterns to Follow

1. **Centralized Routing**: Keep all route matching in the main fetch
   handler
2. **Route Handlers**: Extract business logic into separate handler
   functions
3. **Response Builders**: Use utility functions for consistent response
   formatting
4. **CORS Middleware Pattern**: Apply CORS headers consistently across
   all responses
5. **Error Handling**: Centralized try/catch with standardized error
   responses

### When to Reconsider

This decision should be reconsidered if:
- API complexity grows significantly (>20 routes with complex patterns)
- Middleware requirements become extensive (auth, logging, rate
  limiting)
- Developer velocity becomes bottlenecked by routing boilerplate
- Team consensus shifts toward framework adoption

## Alternative Considered

### Option: Adopt Hono Web Framework

**Description**: Hono is a lightweight, ultra-fast web framework for
Cloudflare Workers with excellent TypeScript support.

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    canopyId: c.env.CANOPY_ID,
  });
});

app.post('/logs/:logId/entries', async (c) => {
  const logId = c.req.param('logId');
  return await registerSignedStatement(c.req.raw, logId, c.env.R2);
});

export default app;
```

**Rejected Because**:

1. **Minimal API Surface**: Current API has only 4 routes - routing
   complexity doesn't justify framework
2. **Bundle Size**: Hono adds ~20KB gzipped; significant for small
   worker
3. **Learning Curve**: Team familiarity with Web Standards >
   framework-specific APIs
4. **Dependency Management**: Additional dependency to maintain and
   update
5. **Custom Requirements**: SCRAPI protocol needs custom CBOR handling
   that frameworks don't optimize for
6. **Performance Critical**: Direct Request handling provides
   predictable performance for high-throughput transparency log

**When Hono Would Be Better**:
- Large API surface (dozens of routes)
- Complex middleware chains
- Team preference for framework ergonomics
- Rapid prototyping phase

## References

- `packages/apps/canopy-api/src/index.ts`: Main routing implementation
- `packages/apps/canopy-api/src/scrapi/cbor-response.ts`: Response
  builders
- [Hono Framework](https://hono.dev/): Alternative framework
- [SCRAPI Specification](https://datatracker.ietf.org/doc/draft-ietf-
  scitt-scrapi/): API protocol requirements
- [Cloudflare Workers Runtime API](https://developers.cloudflare.com/
  workers/runtime-apis/): Native Web Standards APIs
