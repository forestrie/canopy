/**
 * Shared test fixtures for SequencingQueue unit tests.
 */

import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import type { SequencingQueueStub } from "@canopy/forestrie-ingress-types";

// Cast env to our Env type (it's provided by the test pool from wrangler.jsonc)
export const testEnv = env as unknown as Env;

/**
 * Get a fresh DO stub with a unique name per test.
 * We cast to SequencingQueueStub since the DO namespace typing is generic.
 */
export function getStub(testName: string): SequencingQueueStub {
  const id = testEnv.SEQUENCING_QUEUE.idFromName(testName);
  return testEnv.SEQUENCING_QUEUE.get(id) as unknown as SequencingQueueStub;
}
