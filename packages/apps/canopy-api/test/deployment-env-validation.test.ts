/**
 * Non-pool workers must have Custodian bootstrap trio or all routes return 503.
 * Vitest pool uses NODE_ENV "test" and skips this check — see AGENTS.md.
 */

import { decode as decodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

const poolEnv = env as unknown as Env;

describe("Bootstrap trio validation (non-pool NODE_ENV)", () => {
  it("returns 503 on /api/health when ROOT_LOG_ID is missing", async () => {
    const badEnv: Env = {
      ...poolEnv,
      NODE_ENV: "development",
      ROOT_LOG_ID: undefined,
      CUSTODIAN_URL: "https://custodian.example/v1",
      CUSTODIAN_BOOTSTRAP_APP_TOKEN: "token",
    };

    const response = await worker.fetch(
      new Request("http://localhost/api/health"),
      badEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    const decoded = decodeCbor(
      new Uint8Array(await response.arrayBuffer()),
    ) as { detail?: string };
    expect(decoded.detail).toMatch(/ROOT_LOG_ID/);
  });
});
