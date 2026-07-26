/**
 * PUT /api/logs/{logId}/webhook dual-field and legacy value-form handling
 * (plan-2607-02 R3/R5, dropped in plan-2607-43 slice 05): both instance-id
 * field names must carry one value, and legacy-form values are converted to
 * canonical CAIP-10 on write for the coordinator-first deploy window.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";

const ADDR = "75be7950f26fe7f15336a10b33a8d8134fadb787";
const CANONICAL_ID = `eip155:84532:0x${ADDR}`;
const LEGACY_BESPOKE = `84532:${ADDR}`;
const THIRD_FORM = `eip155:84532:${ADDR.toUpperCase()}`;

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function putBinding(
  body: Record<string, string>,
): Promise<{ status: number; logUuid: string }> {
  const logUuid = randomUUID();
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/webhook`,
    { method: "PUT", headers: headers(), body: JSON.stringify(body) },
  );
  return { status: res.status, logUuid };
}

async function getStoredInstanceId(
  logUuid: string,
): Promise<string | undefined> {
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/webhook`,
    { method: "GET", headers: headers() },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { univocityInstanceId?: string };
  return body.univocityInstanceId;
}

describe("PUT /webhook dual instance-id fields (R3)", () => {
  it("accepts both fields carrying the same value", async () => {
    const { status, logUuid } = await putBinding({
      univocityInstanceId: CANONICAL_ID,
      instanceKey: CANONICAL_ID,
    });
    expect(status).toBe(200);
    expect(await getStoredInstanceId(logUuid)).toBe(CANONICAL_ID);
  });

  it("rejects both fields carrying different values", async () => {
    const { status } = await putBinding({
      univocityInstanceId: CANONICAL_ID,
      instanceKey: `eip155:84532:0x${"ab".repeat(20)}`,
    });
    expect(status).toBe(400);
  });
});

describe("PUT /webhook legacy value-form shim (R5)", () => {
  it("converts a legacy bespoke value under instanceKey", async () => {
    const { status, logUuid } = await putBinding({
      instanceKey: LEGACY_BESPOKE,
    });
    expect(status).toBe(200);
    expect(await getStoredInstanceId(logUuid)).toBe(CANONICAL_ID);
  });

  it("converts a legacy bespoke value under univocityInstanceId", async () => {
    const { status, logUuid } = await putBinding({
      univocityInstanceId: LEGACY_BESPOKE,
    });
    expect(status).toBe(200);
    expect(await getStoredInstanceId(logUuid)).toBe(CANONICAL_ID);
  });

  it("converts the third format (unprefixed CAIP-10, any hex case)", async () => {
    const { status, logUuid } = await putBinding({
      univocityInstanceId: THIRD_FORM,
    });
    expect(status).toBe(200);
    expect(await getStoredInstanceId(logUuid)).toBe(CANONICAL_ID);
  });

  it("still rejects a value that is neither canonical nor legacy", async () => {
    const { status } = await putBinding({
      univocityInstanceId: "not-an-id!",
    });
    expect(status).toBe(400);
  });
});
