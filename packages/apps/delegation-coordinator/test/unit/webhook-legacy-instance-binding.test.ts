/**
 * PUT /api/logs/{logId}/webhook strict instance-id handling (plan-2607-43
 * slice 05): the deploy-window `instanceKey` alias and the legacy value-form
 * conversion (plan-2607-02 R3/R5) are gone. `univocityInstanceId` is the only
 * accepted field and canonical CAIP-10 the only accepted form — these tests
 * pin the removal so the shims cannot silently return.
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

describe("PUT /webhook strict instance binding (slice 05)", () => {
  it("accepts the canonical field and value", async () => {
    const { status } = await putBinding({ univocityInstanceId: CANONICAL_ID });
    expect(status).toBe(200);
  });

  it("ignores the retired instanceKey field: alone it is a missing id", async () => {
    const { status } = await putBinding({ instanceKey: CANONICAL_ID });
    expect(status).toBe(400);
  });

  it("rejects legacy value forms under the canonical field", async () => {
    for (const legacy of [LEGACY_BESPOKE, THIRD_FORM]) {
      const { status } = await putBinding({ univocityInstanceId: legacy });
      expect(status).toBe(400);
    }
  });
});
