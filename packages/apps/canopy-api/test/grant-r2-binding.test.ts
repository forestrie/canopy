/**
 * Grants R2 binding verification (Plan 0001 Step 3).
 * Minimal test that R2_GRANTS.put(key, body) and R2_GRANTS.get(key) succeed.
 * Path shape matches Forestrie-Grant v0 content-addressed convention (grant/…).
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index.js";

const testEnv = env as unknown as Env;

describe("R2_GRANTS binding", () => {
  it("put and get succeed at a test path", async () => {
    if (!("R2_GRANTS" in testEnv)) {
      throw new Error(
        "test env missing R2_GRANTS binding (run wrangler types / update worker-configuration.d.ts)",
      );
    }
    const key =
      "grant/0000000000000000000000000000000000000000000000000000000000000000.cbor";
    const body = new Uint8Array([0x01, 0x02, 0x03]);
    await testEnv.R2_GRANTS.put(key, body);
    const obj = await testEnv.R2_GRANTS.get(key);
    expect(obj).not.toBeNull();
    const array = await obj!.arrayBuffer();
    expect(new Uint8Array(array)).toEqual(body);
  });
});
