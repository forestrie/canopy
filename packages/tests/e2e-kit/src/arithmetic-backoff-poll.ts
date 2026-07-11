import type { APIRequestContext } from "@playwright/test";
import {
  queryRegistrationOnce,
  resolveReceiptOnce,
} from "@forestrie/scrapi-client";
import { playwrightFetch } from "./playwright-fetch.js";

/**
 * Backoff ladders + poll loops over the @forestrie/scrapi-client poll-once
 * primitives (plan-2607-12 Phase 2, FOR-351): the package interprets one GET;
 * the kit owns pacing, timeouts and Playwright plumbing.
 */

/**
 * Max wall-clock for one poll-until-done loop (registration status redirect,
 * receipt 200, MMRS retry, etc.). Per-attempt backoff stays sub-second; this
 * caps total polling only.
 */
export const E2E_POLL_MAX_WAIT_MS = 30_000;

/** Playwright harness for serial suites with several 30s poll stages in one test. */
export const E2E_SYSTEM_TEST_TIMEOUT_MS = E2E_POLL_MAX_WAIT_MS * 8 + 15_000;

/**
 * Per-attempt wait (milliseconds) before the next query-registration-status GET
 * after a pending 303. Index advances each poll; the **last** entry is reused for
 * further polls (arithmetic-style ladder: e.g. 100,200,… then stay at 1000).
 * Tests may assign a custom array before running.
 */
export let sequencingBackoff: number[] = [
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
];

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollUntilReceiptOptions {
  request: APIRequestContext;
  /** GET /logs/{bootstrap}/{logId}/entries/{innerHex} (registration status). */
  statusUrlAbsolute: string;
  baseURL: string;
  /** Defaults to {@link sequencingBackoff} if omitted. */
  ladderMs?: number[];
  maxWaitMs?: number;
  accept?: string;
}

export interface PollUntilReceiptResult {
  receiptUrlAbsolute: string;
  entryIdHex: string;
}

/**
 * Poll query-registration-status until the worker returns 303 to the permanent
 * receipt URL (`/logs/.../{massifHeight}/entries/{entryId}/receipt`).
 */
export async function pollQueryRegistrationUntilReceiptRedirect(
  opts: PollUntilReceiptOptions,
): Promise<PollUntilReceiptResult> {
  const ladder = opts.ladderMs ?? sequencingBackoff;
  if (ladder.length === 0) {
    throw new Error("sequencingBackoff / ladderMs must be non-empty");
  }

  const fetchImpl = playwrightFetch(opts.request);
  const maxWaitMs = opts.maxWaitMs ?? E2E_POLL_MAX_WAIT_MS;
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWaitMs) {
    const polled = await queryRegistrationOnce({
      statusUrl: opts.statusUrlAbsolute,
      baseUrl: opts.baseURL,
      accept: opts.accept,
      fetchImpl,
    });

    if (polled.status === "error") {
      if (polled.httpStatus !== 303) {
        throw new Error(
          `poll registration status: expected 303, got ${polled.httpStatus} for ${opts.statusUrlAbsolute}`,
        );
      }
      throw new Error("poll registration status: 303 without Location");
    }

    if (polled.status === "receipt") {
      return {
        receiptUrlAbsolute: polled.receiptUrl,
        entryIdHex: polled.entryIdHex,
      };
    }

    const ladderStep = ladder[Math.min(attempt, ladder.length - 1)]!;
    const waitMs = polled.retryAfterMs
      ? Math.max(ladderStep, polled.retryAfterMs)
      : ladderStep;
    await sleepMs(waitMs);
    attempt++;
  }

  throw new Error(
    `poll registration status: no receipt redirect within ${maxWaitMs}ms (${opts.statusUrlAbsolute}). ` +
      `Grant sequencing may still be pending: run forestrie-ingress (dev) so the SequencingQueue ` +
      `can produce MMRS data, then query-registration-status can redirect to the receipt URL (see repo AGENTS.md).`,
  );
}

export interface PollReceiptBodyOptions {
  request: APIRequestContext;
  receiptUrlAbsolute: string;
  ladderMs?: number[];
  /** Budget after registration already returned a receipt Location (R2 may lag). */
  maxWaitMs?: number;
  accept?: string;
}

/**
 * GET resolve-receipt until 200. Query-registration-status may 303 to the
 * permanent receipt URL before checkpoint/massif objects exist in R2 (404).
 */
export async function pollResolveReceiptUntil200(
  opts: PollReceiptBodyOptions,
): Promise<{
  status: number;
  headers: { [key: string]: string };
  body: Uint8Array;
}> {
  const ladder = opts.ladderMs ?? sequencingBackoff;
  const fetchImpl = playwrightFetch(opts.request);
  const maxWaitMs = opts.maxWaitMs ?? E2E_POLL_MAX_WAIT_MS;
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWaitMs) {
    const resolved = await resolveReceiptOnce({
      receiptUrl: opts.receiptUrlAbsolute,
      accept: opts.accept,
      fetchImpl,
    });
    if (resolved.status === "receipt") {
      return {
        status: resolved.httpStatus,
        headers: resolved.headers,
        body: resolved.body,
      };
    }
    if (resolved.status === "error") {
      throw new Error(
        `resolve-receipt: expected 200 or retryable 404, got ${resolved.httpStatus} for ${opts.receiptUrlAbsolute}`,
      );
    }
    const ladderStep = ladder[Math.min(attempt, ladder.length - 1)]!;
    await sleepMs(ladderStep);
    attempt++;
  }

  throw new Error(
    `resolve-receipt: 404 until timeout ${maxWaitMs}ms (${opts.receiptUrlAbsolute}). ` +
      `MMRS checkpoint/massif may still be writing after sequencing ack.`,
  );
}
