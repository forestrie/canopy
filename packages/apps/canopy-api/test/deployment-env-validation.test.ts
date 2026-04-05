/**
 * Non-pool workers must have Custodian bootstrap trio, SEQUENCING_QUEUE, and
 * CUSTODIAN_APP_TOKEN (and must not set the pool-only receipt test hex).
 * Vitest pool uses NODE_ENV "test" and skips these checks — see AGENTS.md.
 */

import { decode as decodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

const poolEnv = env as unknown as Env;

const fakeQueue = {} as DurableObjectNamespace;

const devLikeBase: Partial<Env> = {
  NODE_ENV: "development",
  ROOT_LOG_ID: "123e4567-e89b-12d3-a456-426614174000",
  CUSTODIAN_URL: "https://custodian.example/v1",
  CUSTODIAN_BOOTSTRAP_APP_TOKEN: "bootstrap-token",
  CUSTODIAN_APP_TOKEN: "app-token",
  SEQUENCING_QUEUE: fakeQueue,
};

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

describe("Sequencing + receipt verifier env (non-pool NODE_ENV)", () => {
  it("returns 503 when SEQUENCING_QUEUE is missing", async () => {
    const badEnv = {
      ...poolEnv,
      ...devLikeBase,
      SEQUENCING_QUEUE: undefined,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("http://localhost/api/health"),
      badEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    const decoded = decodeCbor(
      new Uint8Array(await response.arrayBuffer()),
    ) as { detail?: string };
    expect(decoded.detail).toMatch(/SEQUENCING_QUEUE/);
  });

  it("returns 503 when CUSTODIAN_APP_TOKEN is missing", async () => {
    const badEnv: Env = {
      ...poolEnv,
      ...devLikeBase,
      CUSTODIAN_APP_TOKEN: undefined,
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
    expect(decoded.detail).toMatch(/CUSTODIAN_APP_TOKEN/);
  });

  it("returns 503 when FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX is set", async () => {
    const badEnv: Env = {
      ...poolEnv,
      ...devLikeBase,
      FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX: "11".repeat(64),
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
    expect(decoded.detail).toMatch(
      /FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX/,
    );
  });
});
