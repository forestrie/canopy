/**
 * Common test fixtures for handler integration tests.
 */

import { env } from "cloudflare:test";
import { encode } from "cbor-x";
import type { Env } from "../../../src/env";

// Cast env to our Env type (it's provided by the test pool from wrangler.jsonc)
export const testEnv = env as unknown as Env;

/**
 * Get a DO stub for testing.
 */
export function getStub(name: string) {
  return testEnv.SEQUENCING_QUEUE.get(
    testEnv.SEQUENCING_QUEUE.idFromName(name),
  );
}

/**
 * Helper to create a test request with JSON body.
 */
export function createRequest(
  path: string,
  options?: {
    method?: string;
    body?: unknown;
    contentType?: string;
  },
): Request {
  const {
    method = "GET",
    body,
    contentType = "application/json",
  } = options ?? {};

  const init: RequestInit = { method };

  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "Content-Type": contentType };
  }

  return new Request(`http://localhost${path}`, init);
}

/**
 * Helper to create a CBOR request (for pull/ack endpoints).
 */
export function createCborRequest(
  path: string,
  method: string,
  body: unknown,
): Request {
  const encoded = encode(body);
  return new Request(`http://localhost${path}`, {
    method,
    body: encoded,
    headers: { "Content-Type": "application/cbor" },
  });
}
