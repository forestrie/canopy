/**
 * Non-pool workers must have CUSTODIAN_URL, SEQUENCING_QUEUE, and CUSTODIAN_APP_TOKEN
 * (and must not set the pool-only receipt test hex).
 * Vitest pool uses NODE_ENV "test" and skips these checks — see AGENTS.md.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import { validGenesisV2Es256CborMap } from "./helpers/genesis-v2-body.js";
import { mintTestOnboardToken } from "./helpers/onboard-token.js";

const poolEnv = env as unknown as Env;

const fakeQueue = {} as DurableObjectNamespace;

const devLikeBase: Partial<Env> = {
  NODE_ENV: "development",
  CUSTODIAN_URL: "https://custodian.example/v1",
  CUSTODIAN_APP_TOKEN: "app-token",
  SEQUENCING_QUEUE: fakeQueue,
};

describe("CUSTODIAN_URL validation (non-pool NODE_ENV)", () => {
  it("returns 503 on /api/health when CUSTODIAN_URL is missing", async () => {
    const badEnv: Env = {
      ...poolEnv,
      NODE_ENV: "development",
      CUSTODIAN_URL: undefined,
      CUSTODIAN_APP_TOKEN: "app",
      SEQUENCING_QUEUE: fakeQueue,
    };

    const response = await worker.fetch(
      new Request("http://localhost/api/health"),
      badEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    const decoded = decodeCborAsObject(
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
    const decoded = decodeCborAsObject(
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
    const decoded = decodeCborAsObject(
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
    const decoded = decodeCborAsObject(
      new Uint8Array(await response.arrayBuffer()),
    ) as { detail?: string };
    expect(decoded.detail).toMatch(
      /FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX/,
    );
  });
});

describe("Payments ops env (non-pool NODE_ENV)", () => {
  it("returns 503 on payments route when CANOPY_OPS_ADMIN_TOKEN is missing", async () => {
    const badEnv = {
      ...poolEnv,
      NODE_ENV: "development",
      CANOPY_OPS_ADMIN_TOKEN: undefined,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "GET",
      }),
      badEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    const decoded = decodeCborAsObject(
      new Uint8Array(await response.arrayBuffer()),
    ) as { detail?: string };
    expect(decoded.detail).toMatch(/CANOPY_OPS_ADMIN_TOKEN/);
  });
});

describe("Forest genesis route env (non-pool NODE_ENV)", () => {
  const forestLogId = "123e4567-e89b-12d3-a456-426614174000";

  it("allows forest genesis POST without bootstrap trio when onboard token is valid", async () => {
    const okEnv = {
      ...poolEnv,
      NODE_ENV: "development",
      CUSTODIAN_URL: undefined,
      CUSTODIAN_APP_TOKEN: undefined,
      SEQUENCING_QUEUE: undefined,
    } as unknown as Env;

    const uniqueLogId = crypto.randomUUID();
    const url = `http://localhost/api/forest/${uniqueLogId}/genesis`;
    const { token } = await mintTestOnboardToken(okEnv);

    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap(),
        ) as Uint8Array,
      }),
      okEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(201);
  });

  it("allows public GET genesis without bootstrap trio", async () => {
    const okEnv = {
      ...poolEnv,
      NODE_ENV: "development",
      CUSTODIAN_URL: undefined,
      CUSTODIAN_APP_TOKEN: undefined,
      SEQUENCING_QUEUE: undefined,
    } as unknown as Env;

    const response = await worker.fetch(
      new Request(`http://localhost/api/forest/${forestLogId}/genesis`, {
        method: "GET",
      }),
      okEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
  });
});
