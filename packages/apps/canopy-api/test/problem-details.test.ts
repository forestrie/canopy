/**
 * Problem-details responses: the media type and field placement clients
 * decode by (devdocs plan-2609-08 phase 3 / plan-2609-09 phase 6).
 *
 * `docs/api/canopy-api.md` says errors are Concise Problem Details served
 * as `application/problem+cbor`; `@forestrie/scrapi-client` and
 * `@forestrie/mcp-resolve` gate their decoders on that type. Until this
 * change every problem body went out as plain `application/cbor`, and the
 * router's catch-all 404s put the human message in `type` (a URI slot)
 * with no `detail`, and dropped their CORS headers by passing the header
 * object where `opts` belongs.
 */
import { env } from "cloudflare:test";
import { decodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import { CBOR_CONTENT_TYPES } from "../src/cbor-api/cbor-content-types.js";
import {
  problemResponse,
  requireAcceptCbor,
  requireContentTypeCbor,
} from "../src/cbor-api/cbor-response.js";
import { ClientErrors, ServerErrors } from "../src/cbor-api/problem-details.js";
import worker from "../src/index";
import type { Env } from "../src/index";

const testEnv = env as unknown as Env;

async function decodeProblem(res: Response): Promise<Record<string, unknown>> {
  const decoded = decodeCborDeterministic(
    new Uint8Array(await res.arrayBuffer()),
  );
  expect(decoded).toBeInstanceOf(Map);
  return Object.fromEntries(decoded as Map<string, unknown>);
}

describe("problemResponse", () => {
  it("is served as application/problem+cbor with the message in detail and type a URI", async () => {
    const res = problemResponse(404, "Not Found", "about:blank", {
      detail: "The requested resource /x was not found",
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(
      CBOR_CONTENT_TYPES.PROBLEM_CBOR,
    );
    expect(await decodeProblem(res)).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "The requested resource /x was not found",
    });
  });

  it("keeps caller headers (CORS) alongside the problem media type", () => {
    const res = problemResponse(405, "Method Not Allowed", "about:blank", {
      detail: "no",
      headers: { "Access-Control-Allow-Origin": "*" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toBe(
      CBOR_CONTENT_TYPES.PROBLEM_CBOR,
    );
  });

  it("the Accept / Content-Type guards put their message in detail", async () => {
    const notAcceptable = requireAcceptCbor(
      new Request("http://x/", { headers: { accept: "text/html" } }),
    );
    expect(notAcceptable?.status).toBe(406);
    expect((await decodeProblem(notAcceptable as Response)).detail).toBe(
      "Only application/cbor is supported",
    );
    const unsupported = requireContentTypeCbor(
      new Request("http://x/", {
        method: "POST",
        headers: { "content-type": "text/plain" },
      }),
    );
    expect(unsupported?.status).toBe(415);
    const body = await decodeProblem(unsupported as Response);
    expect(body.detail).toBe("Use application/cbor");
    expect(body.type).toBe("about:blank");
  });
});

describe("ClientErrors / ServerErrors", () => {
  it("every helper is served as application/problem+cbor", () => {
    const responses = [
      ClientErrors.badRequest("x"),
      ClientErrors.unauthorized("x", { "WWW-Authenticate": "Bearer" }),
      ClientErrors.forbidden("x", { reason: "grant_not_found" }),
      ClientErrors.notFound("Entry receipt not found (checkpoint missing)"),
      ClientErrors.conflict("x"),
      ClientErrors.tooManyRequests("x"),
      ServerErrors.internal("x"),
      ServerErrors.serviceUnavailableWithRetry("x", 5),
    ];
    for (const res of responses) {
      expect(res.headers.get("content-type")).toBe(
        CBOR_CONTENT_TYPES.PROBLEM_CBOR,
      );
    }
    expect(responses[1]?.headers.get("www-authenticate")).toBe("Bearer");
    expect(responses[7]?.headers.get("retry-after")).toBe("5");
  });

  it("the receipt route's not-found keeps the operator's title where clients read it", async () => {
    const res = ClientErrors.notFound(
      "Entry receipt not found (checkpoint missing)",
    );
    expect(res.status).toBe(404);
    expect(await decodeProblem(res)).toEqual({
      type: "about:blank",
      title: "Entry receipt not found (checkpoint missing)",
      status: 404,
    });
  });
});

describe("the router's catch-all problems", () => {
  it("an unknown /logs route is a 404 problem document with the message in detail and CORS headers intact", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/logs/nope"),
      testEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe(
      CBOR_CONTENT_TYPES.PROBLEM_CBOR,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await decodeProblem(res);
    expect(body.type).toBe("about:blank");
    expect(body.title).toBe("Not Found");
    expect(body.detail).toBe("The requested resource /logs/nope was not found");
  });
});
