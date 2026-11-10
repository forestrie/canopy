/**
 * The kit waits out 409 `authority-pending` the way a client should: a log
 * takes writes only once it is anchored on chain, which can take one
 * published checkpoint of its owner (protocol ADR-0070).
 */
import { encodeCborDeterministic } from "@forestrie/encoding";
import type { APIResponse } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { retryWhileAuthorityPending } from "../src/authority-pending-retry.js";

function answer(
  status: number,
  problemType?: string,
  retryAfter?: string,
): APIResponse {
  const body = problemType
    ? Buffer.from(encodeCborDeterministic({ type: problemType, status }))
    : Buffer.alloc(0);
  return {
    status: () => status,
    headers: () => ({
      "content-type": "application/cbor",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    }),
    body: async () => body,
  } as unknown as APIResponse;
}

const pending = () => answer(409, "authority-pending", "30");

function scripted(answers: APIResponse[]) {
  let calls = 0;
  const post = async () => answers[Math.min(calls++, answers.length - 1)]!;
  return { post, calls: () => calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { sleep: async (ms: number) => void waits.push(ms), waits };
}

describe("retryWhileAuthorityPending", () => {
  it("retries a pending log, waiting Retry-After each time, until it anchors", async () => {
    const accepted = answer(303);
    const { post, calls } = scripted([pending(), pending(), accepted]);
    const { sleep, waits } = recordingSleep();

    const res = await retryWhileAuthorityPending(post, { sleep });

    expect(res).toBe(accepted);
    expect(calls()).toBe(3);
    expect(waits).toEqual([30_000, 30_000]);
  });

  it("returns any other answer at once, a conflict included", async () => {
    const conflict = answer(409, "authority-conflict");
    const { post, calls } = scripted([conflict]);
    const { sleep, waits } = recordingSleep();

    expect(await retryWhileAuthorityPending(post, { sleep })).toBe(conflict);
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("stops at its budget and returns the last pending answer", async () => {
    const { post, calls } = scripted([pending()]);
    const { sleep, waits } = recordingSleep();

    const res = await retryWhileAuthorityPending(post, {
      sleep,
      maxWaitMs: 70_000,
    });

    expect(res.status()).toBe(409);
    expect(waits).toEqual([30_000, 30_000, 10_000]);
    expect(calls()).toBe(4);
  });
});
