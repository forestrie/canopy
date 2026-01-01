/**
 * Common test fixtures for handler integration tests.
 */

import { env } from "cloudflare:test";
import { encode } from "cbor-x";
import { shardNameForIndex } from "@canopy/forestrie-sharding";
import type { Env } from "../../../src/env";

// Cast env to our Env type (it's provided by the test pool from wrangler.jsonc)
export const testEnv = env as unknown as Env;

/** Default shard index for tests */
export const DEFAULT_SHARD = 0;

/**
 * Get a DO stub for testing by shard index.
 * Uses the default shard (0) if no index is provided.
 */
export function getStub(shardIndex: number = DEFAULT_SHARD) {
  const shardName = shardNameForIndex(shardIndex);
  return testEnv.SEQUENCING_QUEUE.get(
    testEnv.SEQUENCING_QUEUE.idFromName(shardName),
  );
}

/**
 * Get a DO stub for testing with a custom name.
 * Used for test isolation when tests need separate DO instances.
 */
export function getStubByName(name: string) {
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
 * Automatically appends ?shard= parameter if not already present.
 */
export function createCborRequest(
  path: string,
  method: string,
  body: unknown,
  shardIndex: number = DEFAULT_SHARD,
): Request {
  const encoded = encode(body);
  // Add shard parameter if not present
  const url = path.includes("?")
    ? `http://localhost${path}&shard=${shardIndex}`
    : `http://localhost${path}?shard=${shardIndex}`;
  return new Request(url, {
    method,
    body: encoded,
    headers: { "Content-Type": "application/cbor" },
  });
}
