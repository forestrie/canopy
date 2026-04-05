import type { APIRequestContext } from "@playwright/test";

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

function toAbsoluteUrl(baseURL: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseURL.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}

/** Location points at GET resolve-receipt (permanent URL with massif height). */
const RECEIPT_LOCATION_RE =
  /\/logs\/[^/]+\/[^/]+\/\d+\/entries\/[0-9a-f]{32}\/receipt(?:\?|$)/i;

function parseEntryIdFromReceiptLocation(location: string): string {
  const m = location.match(/\/entries\/([0-9a-f]{32})\/receipt/i);
  if (!m) {
    throw new Error(
      `Could not parse entryId from receipt Location: ${location}`,
    );
  }
  return m[1]!.toLowerCase();
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

  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const accept = opts.accept ?? "application/cbor";
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWaitMs) {
    const res = await opts.request.get(opts.statusUrlAbsolute, {
      maxRedirects: 0,
      headers: { Accept: accept },
    });

    if (res.status() !== 303) {
      throw new Error(
        `poll registration status: expected 303, got ${res.status()} for ${opts.statusUrlAbsolute}`,
      );
    }

    const loc = res.headers()["location"];
    if (!loc) {
      throw new Error("poll registration status: 303 without Location");
    }

    if (RECEIPT_LOCATION_RE.test(loc)) {
      const entryIdHex = parseEntryIdFromReceiptLocation(loc);
      return {
        receiptUrlAbsolute: toAbsoluteUrl(opts.baseURL, loc),
        entryIdHex,
      };
    }

    const ladderStep = ladder[Math.min(attempt, ladder.length - 1)]!;
    const retryAfterSec = Number.parseInt(
      res.headers()["retry-after"] ?? "0",
      10,
    );
    const waitMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.max(ladderStep, retryAfterSec * 1000)
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
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const accept = opts.accept ?? "application/cbor";
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWaitMs) {
    const res = await opts.request.get(opts.receiptUrlAbsolute, {
      headers: { Accept: accept },
    });
    if (res.status() === 200) {
      return {
        status: res.status(),
        headers: res.headers(),
        body: new Uint8Array(await res.body()),
      };
    }
    if (res.status() !== 404) {
      throw new Error(
        `resolve-receipt: expected 200 or retryable 404, got ${res.status()} for ${opts.receiptUrlAbsolute}`,
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
