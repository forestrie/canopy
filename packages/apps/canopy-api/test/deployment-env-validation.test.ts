/**
 * Non-pool workers must have Custodian bootstrap trio, SEQUENCING_QUEUE, and
 * CUSTODIAN_APP_TOKEN (and must not set the pool-only receipt test hex).
 * Vitest pool uses NODE_ENV "test" and skips these checks — see AGENTS.md.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "../src/cose/cose-key.js";
import worker from "../src/index";
import type { Env } from "../src/index";

const poolEnv = env as unknown as Env;

const fakeQueue = {} as DurableObjectNamespace;

const devLikeBase: Partial<Env> = {
  NODE_ENV: "development",
  CUSTODIAN_URL: "https://custodian.example/v1",
  CUSTODIAN_BOOTSTRAP_APP_TOKEN: "bootstrap-token",
  CUSTODIAN_APP_TOKEN: "app-token",
  SEQUENCING_QUEUE: fakeQueue,
};

describe("Bootstrap duo validation (non-pool NODE_ENV)", () => {
  it("returns 503 on /api/health when CUSTODIAN_URL is missing", async () => {
    const badEnv: Env = {
      ...poolEnv,
      NODE_ENV: "development",
      CUSTODIAN_URL: undefined,
      CUSTODIAN_BOOTSTRAP_APP_TOKEN: "token",
      CUSTODIAN_APP_TOKEN: "app",
      SEQUENCING_QUEUE: fakeQueue,
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
    expect(decoded.detail).toMatch(/CUSTODIAN_URL/);
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

describe("Forest admin env (non-pool NODE_ENV)", () => {
  const forestLogId = "123e4567-e89b-12d3-a456-426614174000";
  const forestUrl = `http://localhost/api/forest/${forestLogId}/genesis`;

  function minimalGenesisBody(): Uint8Array {
    const x = new Uint8Array(32).fill(0x01);
    const y = new Uint8Array(32).fill(0x02);
    return encodeCbor(
      new Map<number, unknown>([
        [COSE_KEY_KTY, COSE_KTY_EC2],
        [COSE_EC2_CRV, COSE_CRV_P256],
        [COSE_EC2_X, x],
        [COSE_EC2_Y, y],
      ]),
    ) as Uint8Array;
  }

  it("returns 503 on forest route when CURATOR_ADMIN_TOKEN is missing", async () => {
    const badEnv = {
      ...poolEnv,
      NODE_ENV: "development",
      CUSTODIAN_URL: undefined,
      CUSTODIAN_BOOTSTRAP_APP_TOKEN: undefined,
      CUSTODIAN_APP_TOKEN: undefined,
      SEQUENCING_QUEUE: undefined,
      CURATOR_ADMIN_TOKEN: undefined,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request(forestUrl, { method: "POST" }),
      badEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    const decoded = decodeCbor(
      new Uint8Array(await response.arrayBuffer()),
    ) as { detail?: string };
    expect(decoded.detail).toMatch(/CURATOR_ADMIN_TOKEN/);
  });

  it("allows forest genesis POST when curator token is set without Custodian trio", async () => {
    const okEnv = {
      ...poolEnv,
      NODE_ENV: "development",
      CUSTODIAN_URL: undefined,
      CUSTODIAN_BOOTSTRAP_APP_TOKEN: undefined,
      CUSTODIAN_APP_TOKEN: undefined,
      SEQUENCING_QUEUE: undefined,
      CURATOR_ADMIN_TOKEN: "dev-forest-admin-token",
    } as unknown as Env;

    const uniqueLogId = crypto.randomUUID();
    const url = `http://localhost/api/forest/${uniqueLogId}/genesis`;

    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: "Bearer dev-forest-admin-token",
          "Content-Type": "application/cbor",
        },
        body: minimalGenesisBody(),
      }),
      okEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(201);
  });
});
