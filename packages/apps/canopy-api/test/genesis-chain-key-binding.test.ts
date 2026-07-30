/**
 * plan-2607-46 slice 01 — ADR-0059 enforced at the registration boundary:
 * genesis bootstrapKey/alg must match the univocity instance's on-chain
 * bootstrapConfig() (via the gate cache here; unit tests never reach RPC),
 * and a same-R retry must repeat the registered genesis byte-for-byte.
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COSE_ALG_KS256 } from "../src/cose/cose-key.js";
import {
  FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
  FOREST_GENESIS_LABEL_GENESIS_ALG,
} from "../src/forest/forest-genesis-labels.js";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  seedGenesisChainIdentity,
  validGenesisV2Es256CborMap,
} from "./helpers/genesis-v2-body.js";
import { mintTestOnboardToken } from "./helpers/onboard-token.js";

const poolEnv = env as unknown as Env;
const testCtx = {} as ExecutionContext;

async function postGenesis(
  logId: string,
  bodyMap: Map<number, unknown>,
  e: Env = poolEnv,
): Promise<Response> {
  const { token } = await mintTestOnboardToken(e, "chain-key-binding-test");
  return worker.fetch(
    new Request(`http://localhost/api/forest/${logId}/genesis`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/cbor",
      },
      body: encodeCborDeterministic(bodyMap) as Uint8Array,
    }),
    e,
    testCtx,
  );
}

describe("genesis chain-anchored bootstrapKey (plan-2607-46 slice 01)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a bootstrapKey that differs from the chain identity with 422", async () => {
    const chainMap = validGenesisV2Es256CborMap({
      bootstrapKey: new Uint8Array(64).fill(0x33),
    });
    await seedGenesisChainIdentity(poolEnv, chainMap);

    const bodyMap = validGenesisV2Es256CborMap({
      bootstrapKey: new Uint8Array(64).fill(0x44),
    });
    const res = await postGenesis(crypto.randomUUID(), bodyMap);
    expect(res.status).toBe(422);
    const problem = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as { detail?: string };
    expect(problem.detail).toMatch(/bootstrapConfig/);
  });

  it("rejects an alg that differs from the chain identity with 422", async () => {
    const chainMap = validGenesisV2Es256CborMap();
    await seedGenesisChainIdentity(poolEnv, chainMap);

    const bodyMap = validGenesisV2Es256CborMap();
    bodyMap.set(FOREST_GENESIS_LABEL_GENESIS_ALG, COSE_ALG_KS256);
    bodyMap.set(
      FOREST_GENESIS_LABEL_BOOTSTRAP_KEY,
      new Uint8Array(20).fill(0x55),
    );
    const res = await postGenesis(crypto.randomUUID(), bodyMap);
    expect(res.status).toBe(422);
  });

  it("returns 503, never a verdict, when the chain probe is unavailable", async () => {
    // No gate-cache seed and every RPC fetch fails: fail closed.
    const failingFetch = vi.fn(async () => {
      throw new Error("rpc unreachable (unit)");
    });
    vi.stubGlobal("fetch", failingFetch as unknown as typeof fetch);

    const bodyMap = validGenesisV2Es256CborMap({
      // Unseeded address — forces a probe attempt.
      univocityAddr: new Uint8Array(20).fill(0x77),
    });
    const res = await postGenesis(crypto.randomUUID(), bodyMap);
    expect(res.status).toBe(503);
  });

  it("rejects a same-R retry whose body diverges from the stored genesis with 409", async () => {
    const logId = crypto.randomUUID();
    const first = validGenesisV2Es256CborMap({
      bootstrapKey: new Uint8Array(64).fill(0x66),
    });
    await seedGenesisChainIdentity(poolEnv, first);
    expect((await postGenesis(logId, first)).status).toBe(201);

    // The chain identity itself moved (re-seeded cache) — even then, a retry
    // for the SAME log id must repeat the registered genesis exactly.
    const diverged = validGenesisV2Es256CborMap({
      bootstrapKey: new Uint8Array(64).fill(0x67),
    });
    await seedGenesisChainIdentity(poolEnv, diverged);
    const res = await postGenesis(logId, diverged);
    expect(res.status).toBe(409);
    const problem = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as { detail?: string };
    expect(problem.detail).toMatch(/different content/);

    // The exact original body stays idempotent.
    await seedGenesisChainIdentity(poolEnv, first);
    expect((await postGenesis(logId, first)).status).toBe(201);
  });
});
