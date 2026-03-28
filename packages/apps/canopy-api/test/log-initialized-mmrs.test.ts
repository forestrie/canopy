import { describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:test";
import {
  firstMassifObjectKey,
  isLogInitializedMmrs,
  massifIndexToObjectKeySegment,
} from "../src/scrapi/log-initialized-mmrs.js";

describe("log-initialized-mmrs", () => {
  it("formats massif index 0 as 16-digit decimal segment", () => {
    expect(massifIndexToObjectKeySegment(0)).toBe("0000000000000000");
    expect(massifIndexToObjectKeySegment(1)).toBe("0000000000000001");
    expect(massifIndexToObjectKeySegment(10)).toBe("0000000000000010");
  });

  it("builds first massif key matching resolve-receipt layout", () => {
    const logId = "00000000-0000-4000-8000-000000000001";
    const h = 14;
    expect(firstMassifObjectKey(logId, h)).toBe(
      `v2/merklelog/massifs/${h}/${logId}/0000000000000000.log`,
    );
  });

  it("isLogInitializedMmrs returns false when object missing", async () => {
    if (!("R2_MMRS" in testEnv)) {
      throw new Error("test env missing R2_MMRS");
    }
    const logId = "33333333-3333-4333-8333-333333333333";
    const key = firstMassifObjectKey(logId, 3);
    const listed = await testEnv.R2_MMRS.list({ prefix: key });
    for (const obj of listed.objects) {
      await testEnv.R2_MMRS.delete(obj.key);
    }

    const init = await isLogInitializedMmrs(logId, testEnv.R2_MMRS, 3);
    expect(init).toBe(false);
  });

  it("isLogInitializedMmrs returns true when first massif object exists", async () => {
    if (!("R2_MMRS" in testEnv)) {
      throw new Error("test env missing R2_MMRS");
    }
    const logId = "44444444-4444-4444-8444-444444444444";
    const key = firstMassifObjectKey(logId, 3);
    await testEnv.R2_MMRS.put(key, new Uint8Array([1]));

    try {
      const init = await isLogInitializedMmrs(logId, testEnv.R2_MMRS, 3);
      expect(init).toBe(true);
    } finally {
      await testEnv.R2_MMRS.delete(key);
    }
  });
});
