/**
 * Plan 0018 / 0028 / 0032: POST /api/forest/{log-id}/genesis — v2-only writes, v0/v1 read.
 */

import { decodeCborDeterministic, encodeCborDeterministic } from "@forestrie/encoding";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  COSE_CRV_P256,
  COSE_EC2_CRV,
  COSE_EC2_X,
  COSE_EC2_Y,
  COSE_KEY_ALG,
  COSE_KEY_KTY,
  COSE_KTY_EC2,
} from "../src/cose/cose-key.js";
import {
  isGenesisV1,
  isGenesisV2,
  parseGenesisCborBytes,
} from "../src/forest/genesis-cache.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
  FOREST_GENESIS_SCHEMA_V1,
  FOREST_GENESIS_SCHEMA_V2,
} from "../src/forest/forest-genesis-labels.js";
import {
  logIdToStorageSegment,
  logIdToWireBytes,
  toPaddedWire32,
} from "../src/grant/log-id-wire.js";
import worker from "../src/index";
import type { Env } from "../src/index";
import { validGenesisV2Es256CborMap } from "./helpers/genesis-v2-body.js";
import { mintTestOnboardToken } from "./helpers/onboard-token.js";

const poolEnv = env as unknown as Env;
const TEST_CHAIN_ID = "84532";
const TEST_UNIVOCITY_ADDR = new Uint8Array(20).fill(0x42);

async function genesisAuthHeader(e: Env): Promise<string> {
  const { token } = await mintTestOnboardToken(e, "forest-genesis-test");
  return `Bearer ${token}`;
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
      body: encodeCborDeterministic(bodyMap),
    },
  );
}

describe("parseGenesisCborBytes", () => {
  it("accepts v0 legacy objects with null chain fields", () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);
    const bytes = encodeCborDeterministic(
      new Map<number, unknown>([
        [COSE_KEY_KTY, COSE_KTY_EC2],
        [COSE_EC2_CRV, COSE_CRV_P256],
        [COSE_EC2_X, x],
        [COSE_EC2_Y, y],
        [COSE_KEY_ALG, COSE_ALG_ES256],
        [FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, toPaddedWire32(wire)],
        [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, null],
        [FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS, null],
      ]),
    ) as Uint8Array;

    const parsed = parseGenesisCborBytes(bytes, wire);
    expect(parsed).not.toBeNull();
    expect(parsed!.schemaVersion).toBe(0);
    expect(parsed!.chainBinding).toBeNull();
    expect(isGenesisV1(parsed!)).toBe(false);
  });

  it("accepts v1 stored objects with chain binding (read-only legacy)", () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);
    const addr = new Uint8Array(20).fill(0xcc);
    const bytes = encodeCborDeterministic(
      new Map<number, unknown>([
        [COSE_KEY_KTY, COSE_KTY_EC2],
        [COSE_EC2_CRV, COSE_CRV_P256],
        [COSE_EC2_X, x],
        [COSE_EC2_Y, y],
        [COSE_KEY_ALG, COSE_ALG_ES256],
        [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V1],
        [FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, toPaddedWire32(wire)],
        [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, addr],
        [FOREST_GENESIS_LABEL_CHAIN_ID, "84532"],
      ]),
    ) as Uint8Array;

    const parsed = parseGenesisCborBytes(bytes, wire);
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.chainBinding?.chainId).toBe("84532");
    expect(isGenesisV1(parsed!)).toBe(true);
  });

  it("accepts v2 KS256 stored objects with 20-byte bootstrapKey", () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const addr = new Uint8Array(20).fill(0xab);
    const safe = new Uint8Array(20).fill(0xcd);
    const bytes = encodeCborDeterministic(
      new Map<number, unknown>([
        [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V2],
        [FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256],
        [FOREST_GENESIS_LABEL_BOOTSTRAP_KEY, safe],
        [FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, toPaddedWire32(wire)],
        [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, addr],
        [FOREST_GENESIS_LABEL_CHAIN_ID, "84532"],
      ]),
    ) as Uint8Array;

    const parsed = parseGenesisCborBytes(bytes, wire);
    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.bootstrapAlg).toBe(COSE_ALG_KS256);
    expect(parsed?.bootstrapKey).toEqual(safe);
    expect(isGenesisV2(parsed!)).toBe(true);
    expect(isGenesisV1(parsed!)).toBe(false);
  });
});

describe("POST /api/forest/{log-id}/genesis (pool test env)", () => {
  it("returns 201 and stores v2 ES256 map with chain binding", async () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const storageSeg = logIdToStorageSegment(wire);
    const e = poolEnv;
    const bootstrapKey = new Uint8Array(64).fill(0x22);
    const auth = await genesisAuthHeader(e);

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Es256CborMap({ bootstrapKey }), auth),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);

    const key = `forests/forest/${storageSeg}/genesis.cbor`;
    const obj = await e.R2_GRANTS.get(key);
    expect(obj).not.toBeNull();
    const map = decodeCborDeterministic(new Uint8Array(await obj!.arrayBuffer())) as Map<
      number,
      unknown
    >;
    expect(map.get(FOREST_GENESIS_LABEL_GENESIS_VERSION)).toBe(2);
    expect(map.get(FOREST_GENESIS_LABEL_GENESIS_ALG)).toBe(COSE_ALG_ES256);
    expect(map.get(FOREST_GENESIS_LABEL_BOOTSTRAP_KEY)).toEqual(bootstrapKey);
    const boot = map.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID) as Uint8Array;
    expect(boot).toBeInstanceOf(Uint8Array);
    expect(boot.length).toBe(32);
    expect([...boot]).toEqual([...toPaddedWire32(wire)]);
    expect(map.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR)).toEqual(
      TEST_UNIVOCITY_ADDR,
    );
    expect(map.get(FOREST_GENESIS_LABEL_CHAIN_ID)).toBe(TEST_CHAIN_ID);
    expect(map.has(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS)).toBe(false);

    expect(storageSeg).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns 400 when genesis-version is 1 (legacy POST rejected)", async () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);
    const v1 = new Map<number, unknown>([
      [COSE_KEY_KTY, COSE_KTY_EC2],
      [COSE_EC2_CRV, COSE_CRV_P256],
      [COSE_EC2_X, x],
      [COSE_EC2_Y, y],
      [COSE_KEY_ALG, COSE_ALG_ES256],
      [FOREST_GENESIS_LABEL_GENESIS_VERSION, FOREST_GENESIS_SCHEMA_V1],
      [FOREST_GENESIS_LABEL_UNIVOCITY_ADDR, TEST_UNIVOCITY_ADDR],
      [FOREST_GENESIS_LABEL_CHAIN_ID, TEST_CHAIN_ID],
    ]);
    const res = await worker.fetch(
      genesisRequest(logId, v1, await genesisAuthHeader(poolEnv)),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when genesis-version is missing", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisV2Es256CborMap();
    m.delete(FOREST_GENESIS_LABEL_GENESIS_VERSION);
    const res = await worker.fetch(
      genesisRequest(logId, m, await genesisAuthHeader(poolEnv)),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when univocity-addr is missing", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisV2Es256CborMap();
    m.delete(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR);
    const res = await worker.fetch(
      genesisRequest(logId, m, await genesisAuthHeader(poolEnv)),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when chain-id is missing", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisV2Es256CborMap();
    m.delete(FOREST_GENESIS_LABEL_CHAIN_ID);
    const res = await worker.fetch(
      genesisRequest(logId, m, await genesisAuthHeader(poolEnv)),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when legacy univocity-chainids (-68012) is sent", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisV2Es256CborMap();
    m.set(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS, [84532]);
    const res = await worker.fetch(
      genesisRequest(logId, m, await genesisAuthHeader(poolEnv)),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 401 when Authorization is missing", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Es256CborMap()),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when Bearer token does not match", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      genesisRequest(logId, validGenesisV2Es256CborMap(), "Bearer wrong-token"),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when chain-id is not supported", async () => {
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(poolEnv);
    const m = validGenesisV2Es256CborMap({ chainId: "999999" });
    const res = await worker.fetch(
      genesisRequest(logId, m, auth),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 201 idempotently when genesis.cbor already exists", async () => {
    const logId = crypto.randomUUID();
    const auth = await genesisAuthHeader(poolEnv);
    const mk = () => genesisRequest(logId, validGenesisV2Es256CborMap(), auth);

    expect(
      (await worker.fetch(mk(), poolEnv, {} as ExecutionContext)).status,
    ).toBe(201);
    expect(
      (await worker.fetch(mk(), poolEnv, {} as ExecutionContext)).status,
    ).toBe(201);
  });

  it("returns 400 when ES256 bootstrapKey length is wrong", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisV2Es256CborMap({
      bootstrapKey: new Uint8Array(32).fill(0xee),
    });
    const res = await worker.fetch(
      genesisRequest(logId, m, await genesisAuthHeader(poolEnv)),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when client sends bootstrap-logid that does not match path", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisV2Es256CborMap();
    m.set(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID, new Uint8Array(32).fill(0xee));
    const res = await worker.fetch(
      genesisRequest(logId, m, await genesisAuthHeader(poolEnv)),
      poolEnv,
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
          Authorization: await genesisAuthHeader(poolEnv),
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(415);
  });

  it("GET returns 404 before genesis exists, 200 application/cbor after POST", async () => {
    const logId = crypto.randomUUID();
    const getReq = new Request(`http://localhost/api/forest/${logId}/genesis`, {
      method: "GET",
    });
    const miss = await worker.fetch(getReq, poolEnv, {} as ExecutionContext);
    expect(miss.status).toBe(404);

    const postOk = await worker.fetch(
      genesisRequest(
        logId,
        validGenesisV2Es256CborMap(),
        await genesisAuthHeader(poolEnv),
      ),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(postOk.status).toBe(201);

    const hit = await worker.fetch(getReq, poolEnv, {} as ExecutionContext);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("Content-Type")).toBe("application/cbor");
    const roundTrip = decodeCborDeterministic(
      new Uint8Array(await hit.arrayBuffer()),
    ) as Map<number, unknown>;
    expect(roundTrip.get(FOREST_GENESIS_LABEL_GENESIS_VERSION)).toBe(2);
    expect(roundTrip.get(FOREST_GENESIS_LABEL_GENESIS_ALG)).toBe(
      COSE_ALG_ES256,
    );
  });
});
