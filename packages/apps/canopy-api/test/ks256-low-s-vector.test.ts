/**
 * The shared KS256 low-s vector against canopy-api's COSE_Sign1 check
 * ({@link verifyKs256CoseSign1}: grants, statements, child-log prepare,
 * and receipt delegation certificates through verifyKs256DelegationCert).
 * Source of truth: forestrie/protocol vectors/fixtures/ks256-low-s.json;
 * canopy's one copy is packages/shared/encoding/src/testdata/, pinned by
 * SHA-256 below. Do not edit the copy; change protocol and re-copy.
 *
 * Each reject case is the high-s twin of an accept case and recovers the same
 * address, so only the s bound refuses it. With RPC configured, a contract
 * root's signature goes to ERC-1271 unchanged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import vectorText from "../../../shared/encoding/src/testdata/ks256-low-s.json?raw";
import {
  COSE_ALG_KS256,
  verifyKs256CoseSign1,
} from "../src/grant/ks256-verify.js";
import type { ParsedKs256RootKey } from "../src/grant/parsed-ks256-root-key.js";

const VECTOR_SHA256 =
  "3a325aaa1bb296316f3f4ef8e2d8a8ae4c1728c00fc283f3cdd2438a2c9d88dc";

interface Ks256LowSCase {
  name: string;
  signer_address_hex: string;
  signature_hex: string;
  cose_sign1_hex: string;
  expect: { result: "accept" } | { result: "reject"; reason: string };
}

const vector = JSON.parse(vectorText) as { cases: Ks256LowSCase[] };

function hex(h: string): Uint8Array {
  return new Uint8Array(h.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

function toHex(b: ArrayBuffer): string {
  return [...new Uint8Array(b)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function root(c: Ks256LowSCase): ParsedKs256RootKey {
  return {
    kind: "KS256",
    alg: COSE_ALG_KS256,
    address: hex(c.signer_address_hex),
  };
}

describe("KS256 low-s vector: verifyKs256CoseSign1", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the pinned copy of the protocol vector", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(vectorText),
    );
    expect(toHex(digest)).toBe(VECTOR_SHA256);
  });

  it.each(vector.cases.map((c) => [c.name, c] as const))(
    "%s",
    async (_name, c) => {
      const ok = await verifyKs256CoseSign1(hex(c.cose_sign1_hex), root(c));
      expect(ok).toBe(c.expect.result === "accept");
    },
  );

  it("hands a contract root the high-s signature unchanged (ERC-1271)", async () => {
    const highS = vector.cases.find((c) => c.name === "reject/high-s")!;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const { id, method, params } = JSON.parse(String(init.body));
        let result = "0x6001";
        if (method === "eth_call") {
          calls.push(params[0].data);
          result = `0x1626ba7e${"0".repeat(56)}`;
        }
        return Response.json({ jsonrpc: "2.0", id, result });
      }),
    );
    const ok = await verifyKs256CoseSign1(
      hex(highS.cose_sign1_hex),
      root(highS),
      {
        rpcUrls: ["https://rpc.test"],
      },
    );
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(highS.signature_hex);
  });
});
