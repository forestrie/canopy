/**
 * Plan 0018: POST /api/forest/{log-id}/genesis — CBOR COSE_Key + R2_GRANTS.
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  COSE_ALG_ES256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "../src/cose/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
} from "../src/forest/forest-genesis-labels.js";
import {
  logIdToWireBytes,
  wireLogIdToHex64,
} from "../src/grant/log-id-wire.js";
import worker from "../src/index";
import type { Env } from "../src/index";

const poolEnv = env as unknown as Env;
const CURATOR = "vitest-curator-admin-token";

function envWithCurator(): Env {
  return { ...poolEnv, CURATOR_ADMIN_TOKEN: CURATOR };
}

function validGenesisCborMap(): Map<number, unknown> {
  const x = new Uint8Array(32);
  const y = new Uint8Array(32);
  x.fill(0x3a);
  y.fill(0x4b);
  return new Map<number, unknown>([
    [COSE_KEY_KTY, COSE_KTY_EC2],
    [COSE_EC2_CRV, COSE_CRV_P256],
    [COSE_EC2_X, x],
    [COSE_EC2_Y, y],
  ]);
}

function genesisRequest(
  logId: string,
  bodyMap: Map<number, unknown>,
  auth?: string,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/cbor",
  };
  if (auth !== undefined) {
    headers.Authorization = auth;
  }
  return new Request(
    `http://localhost/api/forest/${encodeURIComponent(logId)}/genesis`,
    {
      method: "POST",
      headers,
      body: encodeCbor(bodyMap) as Uint8Array,
    },
  );
}

describe("POST /api/forest/{log-id}/genesis (pool test env)", () => {
  it("returns 201 and stores a map with COSE_Key + bootstrap-logid wire bytes", async () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const hex64 = wireLogIdToHex64(wire);
    const e = envWithCurator();

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisCborMap(), `Bearer ${CURATOR}`),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);

    const key = `forest/${hex64}/genesis.cbor`;
    const obj = await e.R2_GRANTS.get(key);
    expect(obj).not.toBeNull();
    const map = decodeCbor(new Uint8Array(await obj!.arrayBuffer())) as Map<
      number,
      unknown
    >;
    expect(map.get(COSE_KEY_KTY)).toBe(COSE_KTY_EC2);
    expect(map.get(COSE_EC2_CRV)).toBe(COSE_CRV_P256);
    expect(map.get(COSE_KEY_ALG)).toBe(COSE_ALG_ES256);
    const boot = map.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID) as Uint8Array;
    expect(boot).toBeInstanceOf(Uint8Array);
    expect(boot.length).toBe(32);
    expect([...boot]).toEqual([...wire]);
    expect(map.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR)).toBeNull();
    expect(map.get(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS)).toBeNull();

    expect(hex64).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns 401 when Authorization is missing", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      genesisRequest(logId, validGenesisCborMap()),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when Bearer token does not match", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      genesisRequest(logId, validGenesisCborMap(), "Bearer wrong-token"),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 409 when genesis.cbor already exists", async () => {
    const logId = crypto.randomUUID();
    const e = envWithCurator();
    const mk = () =>
      genesisRequest(logId, validGenesisCborMap(), `Bearer ${CURATOR}`);

    expect((await worker.fetch(mk(), e, {} as ExecutionContext)).status).toBe(
      201,
    );
    expect((await worker.fetch(mk(), e, {} as ExecutionContext)).status).toBe(
      409,
    );
  });

  it("returns 400 for non-EC2 COSE kty", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisCborMap();
    m.set(COSE_KEY_KTY, 999);
    const res = await worker.fetch(
      genesisRequest(logId, m, `Bearer ${CURATOR}`),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when client sends bootstrap-logid that does not match path", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisCborMap();
    m.set(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, new Uint8Array(32).fill(0xee));
    const res = await worker.fetch(
      genesisRequest(logId, m, `Bearer ${CURATOR}`),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 415 when Content-Type is not application/cbor", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${logId}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CURATOR}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(415);
  });

  it("GET returns 404 before genesis exists, 200 application/cbor after POST", async () => {
    const logId = crypto.randomUUID();
    const e = envWithCurator();
    const getReq = new Request(`http://localhost/api/forest/${logId}/genesis`, {
      method: "GET",
    });
    const miss = await worker.fetch(getReq, e, {} as ExecutionContext);
    expect(miss.status).toBe(404);

    const postOk = await worker.fetch(
      genesisRequest(logId, validGenesisCborMap(), `Bearer ${CURATOR}`),
      e,
      {} as ExecutionContext,
    );
    expect(postOk.status).toBe(201);

    const hit = await worker.fetch(getReq, e, {} as ExecutionContext);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("Content-Type")).toBe("application/cbor");
    const roundTrip = decodeCbor(
      new Uint8Array(await hit.arrayBuffer()),
    ) as Map<number, unknown>;
    expect(roundTrip.get(COSE_KEY_KTY)).toBe(COSE_KTY_EC2);
  });
});
