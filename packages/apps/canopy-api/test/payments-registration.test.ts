/**
 * Onboard-token store + ops API (FOR-102).
 */

import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  isOnboardTokenActive,
  mintOnboardToken,
  readOnboardTokenRecord,
  revokeOnboardToken,
} from "../src/payments/onboard-token-store.js";
import {
  completeUnivocityInstanceReservation,
  readUnivocityInstanceReservation,
  reserveUnivocityInstance,
  setUnivocityInstanceRegistrationBlock,
} from "../src/payments/instance-registry.js";
import {
  seedGenesisChainIdentity,
  validGenesisV2Es256CborMap,
} from "./helpers/genesis-v2-body.js";

const poolEnv = env as unknown as Env;
const OPS = "vitest-ops-admin-token";

function envWithOps(): Env {
  return { ...poolEnv, CANOPY_OPS_ADMIN_TOKEN: OPS };
}

function opsHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${OPS}`,
    "Content-Type": "application/cbor",
    ...extra,
  };
}

describe("onboard token store", () => {
  it("mints an active token retrievable by hash only", async () => {
    const minted = await mintOnboardToken(poolEnv, {
      label: "e2e-test",
      chainBinding: { chainId: "84532", univocityAddr: "99".repeat(20) },
    });
    expect(minted.token.length).toBeGreaterThan(0);
    expect(minted.record.status).toBe("active");
    const active = await isOnboardTokenActive(poolEnv, minted.token);
    expect(active).toEqual({ active: true, hash: minted.record.hash });
  });

  it("revoked token is not active", async () => {
    const minted = await mintOnboardToken(poolEnv, {
      chainBinding: { chainId: "84532", univocityAddr: "42".repeat(20) },
    });
    await revokeOnboardToken(poolEnv, minted.record.hash);
    const active = await isOnboardTokenActive(poolEnv, minted.token);
    expect(active).toEqual({ active: false });
  });
});

describe("ops onboard-token API", () => {
  it("POST mint returns token once and GET lists hash metadata", async () => {
    const postRes = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "POST",
        headers: opsHeaders(),
        body: encodeCborDeterministic(
          new Map<number, unknown>([
            [1, "mint-spec"],
            [3, "84532"],
            [4, "61".repeat(20)],
          ]),
        ) as Uint8Array,
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(postRes.status).toBe(201);
    const minted = decodeCborAsObject(
      new Uint8Array(await postRes.arrayBuffer()),
    ) as {
      token?: string;
      ref?: string;
      status?: string;
      label?: string;
    };
    expect(minted.token).toBeTruthy();
    expect(minted.ref).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.status).toBe("active");
    expect(minted.label).toBe("mint-spec");

    const listRes = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "GET",
        headers: { Authorization: `Bearer ${OPS}` },
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(listRes.status).toBe(200);
    const listed = decodeCborAsObject(
      new Uint8Array(await listRes.arrayBuffer()),
    ) as {
      tokens?: { hash: string }[];
    };
    expect(listed.tokens?.some((t) => t.hash === minted.ref)).toBe(true);
  });

  it("DELETE revokes by ref", async () => {
    const minted = await mintOnboardToken(poolEnv, {
      chainBinding: { chainId: "84532", univocityAddr: "42".repeat(20) },
    });
    const delRes = await worker.fetch(
      new Request(
        `http://localhost/api/payments/onboard-tokens/${minted.record.hash}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${OPS}` },
        },
      ),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(delRes.status).toBe(200);
    const active = await isOnboardTokenActive(poolEnv, minted.token);
    expect(active.active).toBe(false);
  });

  it("rejects ops routes without bearer", async () => {
    const res = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "GET",
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe("genesis onboard-token auth", () => {
  it("POST genesis with a valid onboard token records the registration (class retired)", async () => {
    const minted = await mintOnboardToken(poolEnv, {
      chainBinding: { chainId: "84532", univocityAddr: "42".repeat(20) },
    });
    const logId = crypto.randomUUID();
    await seedGenesisChainIdentity(poolEnv, validGenesisV2Es256CborMap());
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${logId}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap(),
        ) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as {
      R?: string;
      class?: string;
      chainBinding?: { chainId?: string };
    };
    expect(body.R).toBe(logId);
    // Class is retired (ADR-0059, slice 02): every root is its own account.
    expect(body.class).toBeUndefined();
    expect(body.chainBinding?.chainId).toBe("84532");
  });

  it("records admittedBy on the registration from the onboard token", async () => {
    const minted = await mintOnboardToken(poolEnv, {
      admittedBy: "ops",
      chainBinding: { chainId: "84532", univocityAddr: "51".repeat(20) },
    });
    const logId = crypto.randomUUID();
    await seedGenesisChainIdentity(
      poolEnv,
      validGenesisV2Es256CborMap({
        univocityAddr: new Uint8Array(20).fill(0x51),
      }),
    );
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${logId}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap({
            univocityAddr: new Uint8Array(20).fill(0x51),
          }),
        ) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const stored = await poolEnv.R2_GRANTS.get(
      `forests/forest/${logId}/registration.json`,
    );
    expect(stored).not.toBeNull();
    const record = JSON.parse(await stored!.text()) as {
      admittedBy?: string;
    };
    expect(record.admittedBy).toBe("ops");
  });

  it("returns 409 when a second forest claims the same univocity instance", async () => {
    const addr = new Uint8Array(20).fill(0x52);
    const first = await mintOnboardToken(poolEnv, {
      chainBinding: { chainId: "84532", univocityAddr: "52".repeat(20) },
    });
    const firstRoot = crypto.randomUUID();
    await seedGenesisChainIdentity(
      poolEnv,
      validGenesisV2Es256CborMap({ univocityAddr: addr }),
    );
    const firstRes = await worker.fetch(
      new Request(`http://localhost/api/forest/${firstRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${first.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap({ univocityAddr: addr }),
        ) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(firstRes.status).toBe(201);

    const second = await mintOnboardToken(poolEnv, {
      chainBinding: { chainId: "84532", univocityAddr: "52".repeat(20) },
    });
    const secondRoot = crypto.randomUUID();
    await seedGenesisChainIdentity(
      poolEnv,
      validGenesisV2Es256CborMap({ univocityAddr: addr }),
    );
    const secondRes = await worker.fetch(
      new Request(`http://localhost/api/forest/${secondRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${second.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap({ univocityAddr: addr }),
        ) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(secondRes.status).toBe(409);

    // The claim index names the holder, so the conflict is diagnosable.
    const claim = await poolEnv.R2_GRANTS.get(
      `forests/index/chain-binding/eip155:84532:0x${"52".repeat(20)}`,
    );
    expect(claim).not.toBeNull();
    const record = JSON.parse(await claim!.text()) as {
      state?: string;
      r?: string;
    };
    expect(record.state).toBe("registered");
    expect(record.r).toBe(firstRoot);

    // The F1 guarantee (ADR-0059 decision 8): the losing token was NOT
    // consumed by the conflict...
    const survivor = await readOnboardTokenRecord(poolEnv, second.record.hash);
    expect(survivor?.consumedForestR).toBeUndefined();

    // ...and remains fully usable: after ops releases the claim, the same
    // token completes genesis for the losing root.
    const { releaseUnivocityInstanceReservation } = await import(
      "../src/payments/instance-registry.js"
    );
    const released = await releaseUnivocityInstanceReservation(
      poolEnv,
      `eip155:84532:0x${"52".repeat(20)}`,
    );
    expect(released?.r).toBe(firstRoot);
    await seedGenesisChainIdentity(
      poolEnv,
      validGenesisV2Es256CborMap({ univocityAddr: addr }),
    );
    const retry = await worker.fetch(
      new Request(`http://localhost/api/forest/${secondRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${second.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap({ univocityAddr: addr }),
        ) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(retry.status).toBe(201);
  });

  it("break-glass mint requires a chain binding and reserves the instance", async () => {
    const noBinding = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "POST",
        headers: opsHeaders(),
        body: encodeCborDeterministic(
          new Map<number, unknown>([[1, "no-binding"]]),
        ) as Uint8Array,
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(noBinding.status).toBe(400);

    const mintBody = () =>
      encodeCborDeterministic(
        new Map<number, unknown>([
          [1, "reserve-spec"],
          [3, "84532"],
          [4, "62".repeat(20)],
        ]),
      ) as Uint8Array;
    const first = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "POST",
        headers: opsHeaders(),
        body: mintBody(),
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(first.status).toBe(201);

    // Second break-glass mint for the same instance: reservation conflict,
    // and the just-minted token is revoked rather than left dangling.
    const second = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "POST",
        headers: opsHeaders(),
        body: mintBody(),
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(second.status).toBe(409);
  });

  it("ops chain-bindings route inspects and releases a reservation", async () => {
    const id = `eip155:84532:0x${"63".repeat(20)}`;
    const mint = await worker.fetch(
      new Request("http://localhost/api/payments/onboard-tokens", {
        method: "POST",
        headers: opsHeaders(),
        body: encodeCborDeterministic(
          new Map<number, unknown>([
            [1, "release-spec"],
            [3, "84532"],
            [4, "63".repeat(20)],
          ]),
        ) as Uint8Array,
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(mint.status).toBe(201);

    const encoded = encodeURIComponent(id);
    const got = await worker.fetch(
      new Request(`http://localhost/api/payments/chain-bindings/${encoded}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${OPS}` },
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(got.status).toBe(200);
    const record = decodeCborAsObject(
      new Uint8Array(await got.arrayBuffer()),
    ) as { state?: string; holder?: string };
    expect(record.state).toBe("reserved");
    expect(record.holder).toMatch(/^token:/);

    const released = await worker.fetch(
      new Request(`http://localhost/api/payments/chain-bindings/${encoded}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${OPS}` },
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(released.status).toBe(200);

    const gone = await worker.fetch(
      new Request(`http://localhost/api/payments/chain-bindings/${encoded}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${OPS}` },
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(gone.status).toBe(404);
  });

  it("ops chain-bindings PATCH repairs the registration block", async () => {
    const id = `eip155:84532:0x${"64".repeat(20)}`;
    await reserveUnivocityInstance(poolEnv, id, "token:64");
    const encoded = encodeURIComponent(id);
    const patch = (body: unknown) =>
      worker.fetch(
        new Request(`http://localhost/api/payments/chain-bindings/${encoded}`, {
          method: "PATCH",
          headers: opsHeaders(),
          body: encodeCborDeterministic(
            new Map<number, unknown>([[1, body]]),
          ) as Uint8Array,
        }),
        envWithOps(),
        {} as ExecutionContext,
      );

    const repaired = await patch(44668380);
    expect(repaired.status).toBe(200);
    const record = decodeCborAsObject(
      new Uint8Array(await repaired.arrayBuffer()),
    ) as { registrationBlock?: number; state?: string };
    expect(record.registrationBlock).toBe(44668380);
    expect(record.state).toBe("reserved");

    expect((await patch("later")).status).toBe(400);
    expect((await patch(-5)).status).toBe(400);

    const missing = await worker.fetch(
      new Request(
        `http://localhost/api/payments/chain-bindings/${encodeURIComponent(
          `eip155:84532:0x${"65".repeat(20)}`,
        )}`,
        {
          method: "PATCH",
          headers: opsHeaders(),
          body: encodeCborDeterministic(
            new Map<number, unknown>([[1, 1]]),
          ) as Uint8Array,
        },
      ),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(404);
  });

  it("reservation completion records the registrationBlock on both paths", async () => {
    // CAS completion of a held reservation.
    const held = `eip155:84532:0x${"66".repeat(20)}`;
    const rHeld = "66666666-6666-4666-8666-666666666666";
    await reserveUnivocityInstance(poolEnv, held, "token:66");
    const completed = await completeUnivocityInstanceReservation(
      poolEnv,
      held,
      ["token:66"],
      rHeld,
      44668380,
    );
    expect(completed.ok).toBe(true);
    expect(
      (await readUnivocityInstanceReservation(poolEnv, held))
        ?.registrationBlock,
    ).toBe(44668380);

    // Direct-create (no reserving admission): the failed-observation posture
    // records an explicit null, distinguishable from a legacy absent field.
    const direct = `eip155:84532:0x${"67".repeat(20)}`;
    const rDirect = "67676767-6767-4767-8767-676767676767";
    const created = await completeUnivocityInstanceReservation(
      poolEnv,
      direct,
      [],
      rDirect,
      null,
    );
    expect(created.ok).toBe(true);
    const record = await readUnivocityInstanceReservation(poolEnv, direct);
    expect(record?.state).toBe("registered");
    expect(record?.registrationBlock).toBeNull();
  });

  it("completion preserves a repaired floor when its own observation fails", async () => {
    // plan-2607-05 R2: null must not clobber an ops-repaired value...
    const repaired = `eip155:84532:0x${"68".repeat(20)}`;
    await reserveUnivocityInstance(poolEnv, repaired, "token:68");
    await setUnivocityInstanceRegistrationBlock(poolEnv, repaired, 100);
    const nullDone = await completeUnivocityInstanceReservation(
      poolEnv,
      repaired,
      ["token:68"],
      "68686868-6868-4868-8868-686868686868",
      null,
    );
    expect(nullDone.ok).toBe(true);
    expect(
      (await readUnivocityInstanceReservation(poolEnv, repaired))
        ?.registrationBlock,
    ).toBe(100);

    // ...while a successful observation wins — it is the measurement at the
    // true registration moment.
    const observed = `eip155:84532:0x${"69".repeat(20)}`;
    await reserveUnivocityInstance(poolEnv, observed, "token:69");
    await setUnivocityInstanceRegistrationBlock(poolEnv, observed, 100);
    const observedDone = await completeUnivocityInstanceReservation(
      poolEnv,
      observed,
      ["token:69"],
      "69696969-6969-4969-8969-696969696969",
      200,
    );
    expect(observedDone.ok).toBe(true);
    expect(
      (await readUnivocityInstanceReservation(poolEnv, observed))
        ?.registrationBlock,
    ).toBe(200);
  });

  it("genesis POST records the observed chain head as the registrationBlock", async () => {
    const head = 44668380;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { method?: string })
        : {};
      if (body.method === "eth_blockNumber") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: `0x${head.toString(16)}`,
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { message: "unexpected method in registration-block test" },
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    try {
      const minted = await mintOnboardToken(poolEnv, {
        chainBinding: { chainId: "84532", univocityAddr: "42".repeat(20) },
      });
      const logId = crypto.randomUUID();
      await seedGenesisChainIdentity(poolEnv, validGenesisV2Es256CborMap());
      const res = await worker.fetch(
        new Request(`http://localhost/api/forest/${logId}/genesis`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${minted.token}`,
            "Content-Type": "application/cbor",
          },
          body: encodeCborDeterministic(
            validGenesisV2Es256CborMap(),
          ) as Uint8Array,
        }),
        poolEnv,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(201);
      const record = await readUnivocityInstanceReservation(
        poolEnv,
        `eip155:84532:0x${"42".repeat(20)}`,
      );
      expect(record?.state).toBe("registered");
      expect(record?.registrationBlock).toBe(head);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("ops chain-bindings PATCH repairs a registered record", async () => {
    const id = `eip155:84532:0x${"70".repeat(20)}`;
    await reserveUnivocityInstance(poolEnv, id, "token:70");
    await completeUnivocityInstanceReservation(
      poolEnv,
      id,
      ["token:70"],
      "70707070-7070-4070-8070-707070707070",
      null,
    );
    const res = await worker.fetch(
      new Request(
        `http://localhost/api/payments/chain-bindings/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: opsHeaders(),
          body: encodeCborDeterministic(
            new Map<number, unknown>([[1, 44668367]]),
          ) as Uint8Array,
        },
      ),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const record = await readUnivocityInstanceReservation(poolEnv, id);
    expect(record?.state).toBe("registered");
    expect(record?.registrationBlock).toBe(44668367);
  });

  it("rejects genesis POST without auth", async () => {
    const logId = crypto.randomUUID();
    await seedGenesisChainIdentity(poolEnv, validGenesisV2Es256CborMap());
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${logId}/genesis`, {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap(),
        ) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe("genesis endorsement-grant auth (retired, ADR-0059 slice 02)", () => {
  it("rejects any Forestrie-Grant genesis with a pointer at the onboarding flow", async () => {
    const childRoot = crypto.randomUUID();
    const signer = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const kid = crypto.getRandomValues(new Uint8Array(16));
    const { derivedEndorsementGrantFlags } = await import(
      "../src/grant/grant-flags.js"
    );
    const { uuidToBytes } = await import("../src/grant/uuid-bytes.js");
    const { forestrieGrantAuthorizationHeader } = await import(
      "./helpers/custodian-transparent-grant.js"
    );
    const grant = {
      logId: uuidToBytes(childRoot),
      ownerLogId: uuidToBytes(crypto.randomUUID()),
      grant: derivedEndorsementGrantFlags(),
      grantData: new Uint8Array(0),
    };
    const authHeader = await forestrieGrantAuthorizationHeader(
      grant,
      signer.privateKey,
      kid,
    );

    await seedGenesisChainIdentity(poolEnv, validGenesisV2Es256CborMap());
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${childRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/cbor",
        },
        body: encodeCborDeterministic(
          validGenesisV2Es256CborMap(),
        ) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
    const body = decodeCborAsObject(
      new Uint8Array(await res.arrayBuffer()),
    ) as { detail?: string };
    expect(body.detail).toMatch(/retired.*onboard/i);
  });

  it("reads a legacy registration record carrying class and endorsedBy", async () => {
    const { readRegistration } = await import(
      "../src/payments/registration-store.js"
    );
    const { logIdToWireBytes } = await import("../src/grant/log-id-wire.js");
    const legacyR = crypto.randomUUID();
    await poolEnv.R2_GRANTS.put(
      `forests/forest/${legacyR}/registration.json`,
      JSON.stringify({
        class: "regular",
        endorsedBy: crypto.randomUUID(),
        chainBinding: { chainId: "84532", univocityAddr: "42".repeat(20) },
        createdAt: 1719000000,
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    const record = await readRegistration(poolEnv, logIdToWireBytes(legacyR));
    expect(record?.class).toBe("regular");
    expect(record?.chainBinding.chainId).toBe("84532");
  });
});
