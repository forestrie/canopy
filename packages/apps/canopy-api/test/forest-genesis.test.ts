/**
 * Plan 0018 / 0028: POST /api/forest/{log-id}/genesis — v1 chain binding + v0 read.
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
  isGenesisV1,
  parseGenesisCborBytes,
} from "../src/forest/genesis-cache.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID,
  FOREST_GENESIS_LABEL_CHAIN_ID,
  FOREST_GENESIS_LABEL_GENESIS_VERSION,
  FOREST_GENESIS_LABEL_UNIVOCITY_ADDR,
  FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS,
  FOREST_GENESIS_SCHEMA_V1,
} from "../src/forest/forest-genesis-labels.js";
import {
  logIdToStorageSegment,
  logIdToWireBytes,
  toPaddedWire32,
} from "../src/grant/log-id-wire.js";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
  FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
  validGenesisV1CborMap,
} from "./helpers/genesis-v1-body.js";

const poolEnv = env as unknown as Env;
const CURATOR = "vitest-curator-admin-token";

function envWithCurator(): Env {
  return { ...poolEnv, CURATOR_ADMIN_TOKEN: CURATOR };
}

function validGenesisCborMap(): Map<number, unknown> {
  return validGenesisV1CborMap();
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

describe("parseGenesisCborBytes", () => {
  it("accepts v0 legacy objects with null chain fields", () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);
    const bytes = encodeCbor(
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

  it("accepts v1 stored objects with chain binding", () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const x = new Uint8Array(32).fill(0x11);
    const y = new Uint8Array(32).fill(0x22);
    const addr = new Uint8Array(20).fill(0xcc);
    const bytes = encodeCbor(
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
});

describe("POST /api/forest/{log-id}/genesis (pool test env)", () => {
  it("returns 201 and stores v1 map with chain binding", async () => {
    const logId = crypto.randomUUID();
    const wire = logIdToWireBytes(logId);
    const storageSeg = logIdToStorageSegment(wire);
    const e = envWithCurator();

    const res = await worker.fetch(
      genesisRequest(logId, validGenesisCborMap(), `Bearer ${CURATOR}`),
      e,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);

    const key = `forests/forest/${storageSeg}/genesis.cbor`;
    const obj = await e.R2_GRANTS.get(key);
    expect(obj).not.toBeNull();
    const map = decodeCbor(new Uint8Array(await obj!.arrayBuffer())) as Map<
      number,
      unknown
    >;
    expect(map.get(COSE_KEY_KTY)).toBe(COSE_KTY_EC2);
    expect(map.get(COSE_EC2_CRV)).toBe(COSE_CRV_P256);
    expect(map.get(COSE_KEY_ALG)).toBe(COSE_ALG_ES256);
    expect(map.get(FOREST_GENESIS_LABEL_GENESIS_VERSION)).toBe(1);
    const boot = map.get(FOREST_GENESIS_LABEL_BOOTSTRAP_LOG_ID) as Uint8Array;
    expect(boot).toBeInstanceOf(Uint8Array);
    expect(boot.length).toBe(32);
    expect([...boot]).toEqual([...toPaddedWire32(wire)]);
    expect(map.get(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR)).toEqual(
      FOREST_GENESIS_E2E_DUMMY_UNIVOCITY_ADDR,
    );
    expect(map.get(FOREST_GENESIS_LABEL_CHAIN_ID)).toBe(
      FOREST_GENESIS_E2E_DUMMY_CHAIN_ID,
    );
    expect(map.has(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS)).toBe(false);

    expect(storageSeg).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns 400 when genesis-version is missing", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisCborMap();
    m.delete(FOREST_GENESIS_LABEL_GENESIS_VERSION);
    const res = await worker.fetch(
      genesisRequest(logId, m, `Bearer ${CURATOR}`),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when univocity-addr is missing", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisCborMap();
    m.delete(FOREST_GENESIS_LABEL_UNIVOCITY_ADDR);
    const res = await worker.fetch(
      genesisRequest(logId, m, `Bearer ${CURATOR}`),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when chain-id is missing", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisCborMap();
    m.delete(FOREST_GENESIS_LABEL_CHAIN_ID);
    const res = await worker.fetch(
      genesisRequest(logId, m, `Bearer ${CURATOR}`),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when legacy univocity-chainids (-68012) is sent", async () => {
    const logId = crypto.randomUUID();
    const m = validGenesisCborMap();
    m.set(FOREST_GENESIS_LABEL_UNIVOCITY_CHAIN_IDS, [84532]);
    const res = await worker.fetch(
      genesisRequest(logId, m, `Bearer ${CURATOR}`),
      envWithCurator(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
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
    expect(roundTrip.get(FOREST_GENESIS_LABEL_GENESIS_VERSION)).toBe(1);
  });
});
