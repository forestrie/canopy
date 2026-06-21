/**
 * Onboard-token store + ops API (FOR-102).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";
import {
  isOnboardTokenActive,
  mintOnboardToken,
  revokeOnboardToken,
} from "../src/payments/onboard-token-store.js";
import { validGenesisV2Es256CborMap } from "./helpers/genesis-v2-body.js";

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
    const minted = await mintOnboardToken(poolEnv, { label: "e2e-test" });
    expect(minted.token.length).toBeGreaterThan(0);
    expect(minted.record.status).toBe("active");
    const active = await isOnboardTokenActive(poolEnv, minted.token);
    expect(active).toEqual({ active: true, hash: minted.record.hash });
  });

  it("revoked token is not active", async () => {
    const minted = await mintOnboardToken(poolEnv);
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
        body: encodeCbor(new Map([[1, "mint-spec"]])) as Uint8Array,
      }),
      envWithOps(),
      {} as ExecutionContext,
    );
    expect(postRes.status).toBe(201);
    const minted = decodeCbor(
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
    const listed = decodeCbor(
      new Uint8Array(await listRes.arrayBuffer()),
    ) as { tokens?: { hash: string }[] };
    expect(listed.tokens?.some((t) => t.hash === minted.ref)).toBe(true);
  });

  it("DELETE revokes by ref", async () => {
    const minted = await mintOnboardToken(poolEnv);
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
  it("POST genesis with valid onboard token records payment-authoritative registration", async () => {
    const minted = await mintOnboardToken(poolEnv);
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${logId}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${minted.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCbor(validGenesisV2Es256CborMap()) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const body = decodeCbor(new Uint8Array(await res.arrayBuffer())) as {
      R?: string;
      class?: string;
      chainBinding?: { chainId?: string };
    };
    expect(body.R).toBe(logId);
    expect(body.class).toBe("payment-authoritative");
    expect(body.chainBinding?.chainId).toBe("84532");
  });

  it("rejects genesis POST without auth", async () => {
    const logId = crypto.randomUUID();
    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${logId}/genesis`, {
        method: "POST",
        headers: { "Content-Type": "application/cbor" },
        body: encodeCbor(validGenesisV2Es256CborMap()) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});

describe("genesis endorsement-grant auth", () => {
  it("POST genesis with GF_DERIVED grant records regular registration", async () => {
    const paRoot = crypto.randomUUID();
    const paToken = await mintOnboardToken(poolEnv);
    const paGenesis = await worker.fetch(
      new Request(`http://localhost/api/forest/${paRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paToken.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCbor(validGenesisV2Es256CborMap()) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(paGenesis.status).toBe(201);

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
      ownerLogId: uuidToBytes(paRoot),
      grant: derivedEndorsementGrantFlags(),
      grantData: new Uint8Array(0),
    };
    const authHeader = await forestrieGrantAuthorizationHeader(
      grant,
      signer.privateKey,
      kid,
    );

    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${childRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/cbor",
        },
        body: encodeCbor(validGenesisV2Es256CborMap()) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(201);
    const body = decodeCbor(new Uint8Array(await res.arrayBuffer())) as {
      class?: string;
      endorsedBy?: string;
      R?: string;
    };
    expect(body.R).toBe(childRoot);
    expect(body.class).toBe("regular");
    expect(body.endorsedBy).toBe(paRoot);
  });

  it("rejects genesis POST when grant lacks GF_DERIVED", async () => {
    const paRoot = crypto.randomUUID();
    const paToken = await mintOnboardToken(poolEnv);
    await worker.fetch(
      new Request(`http://localhost/api/forest/${paRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paToken.token}`,
          "Content-Type": "application/cbor",
        },
        body: encodeCbor(validGenesisV2Es256CborMap()) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );

    const childRoot = crypto.randomUUID();
    const signer = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const kid = crypto.getRandomValues(new Uint8Array(16));
    const { uuidToBytes } = await import("../src/grant/uuid-bytes.js");
    const { forestrieGrantAuthorizationHeader } = await import(
      "./helpers/custodian-transparent-grant.js"
    );
    const grant = {
      logId: uuidToBytes(childRoot),
      ownerLogId: uuidToBytes(paRoot),
      grant: new Uint8Array(8),
      grantData: new Uint8Array(0),
    };
    const authHeader = await forestrieGrantAuthorizationHeader(
      grant,
      signer.privateKey,
      kid,
    );

    const res = await worker.fetch(
      new Request(`http://localhost/api/forest/${childRoot}/genesis`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/cbor",
        },
        body: encodeCbor(validGenesisV2Es256CborMap()) as Uint8Array,
      }),
      poolEnv,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });
});
