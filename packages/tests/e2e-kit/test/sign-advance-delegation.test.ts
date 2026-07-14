/**
 * signAdvanceDelegation (FOR-390 phase E): pre-delegate to the sealer's
 * standing key by reading the window-less standing entry (C3) and submitting a
 * wide certificate + on-chain signature. Hermetic — the coordinator HTTP
 * surface is faked; only the kit's read/build/submit wiring is under test.
 */

import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
  hex32ToWireLogId,
  signAdvanceDelegation,
} from "../src/coordinator-delegation-helpers.js";

const LOG_HEX32 = "0123456789abcdef0123456789abcdef";

interface CapturedPost {
  url: string;
  data: Record<string, unknown>;
}

function fakeRequest(opts: {
  standingKeyB64: string | null;
  postStatus?: number;
}) {
  const posts: CapturedPost[] = [];
  const entries = opts.standingKeyB64
    ? [{ delegatedPublicKey: opts.standingKeyB64, suggestedTtlSeconds: 3600 }]
    : [];
  const request = {
    get: async (_url: string) => ({
      ok: () => true,
      status: () => 200,
      json: async () => ({ entries }),
    }),
    post: async (url: string, options?: { data?: unknown }) => {
      posts.push({
        url,
        data: (options?.data ?? {}) as Record<string, unknown>,
      });
      const status = opts.postStatus ?? 200;
      return {
        ok: () => status >= 200 && status < 300,
        status: () => status,
        text: async () => "err",
      };
    },
  };
  return { request, posts };
}

describe("signAdvanceDelegation", () => {
  it("signs and submits a wide advance cert bound to the standing key", async () => {
    const standingKey = await generateEphemeralDelegatedPublicKeyCbor();
    const standingKeyB64 = bytesToBase64(standingKey);
    const { request, posts } = fakeRequest({ standingKeyB64 });
    const rootKeyPair = await generateEs256RootKeyPair();

    const result = await signAdvanceDelegation({
      request,
      coordinatorUrl: "https://coord.test",
      logId: LOG_HEX32,
      logIdHex32: LOG_HEX32,
      rootKeyPair,
      horizonMmrEnd: 65535,
    });

    expect(result.mmrStart).toBe(0);
    expect(result.mmrEnd).toBe(65535);
    expect(result.delegatedPublicKey).toBe(standingKeyB64);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(
      "https://coord.test/api/delegations/certificate",
    );
    const body = posts[0]!.data;
    expect(body.logId).toBe(LOG_HEX32);
    expect(body.mmrStart).toBe(0);
    expect(body.mmrEnd).toBe(65535);
    expect(body.delegatedPublicKey).toBe(standingKeyB64);
    // V3: the on-chain signature is REQUIRED on advance submits.
    expect(typeof body.onchainSignature).toBe("string");
    expect((body.onchainSignature as string).length).toBeGreaterThan(0);
    expect(typeof body.certificate).toBe("string");
  });

  it("throws when there is no standing entry (no root/delegate key yet)", async () => {
    const { request } = fakeRequest({ standingKeyB64: null });
    const rootKeyPair = await generateEs256RootKeyPair();
    await expect(
      signAdvanceDelegation({
        request,
        coordinatorUrl: "https://coord.test",
        logId: LOG_HEX32,
        logIdHex32: LOG_HEX32,
        rootKeyPair,
        horizonMmrEnd: 100,
      }),
    ).rejects.toThrow(/no standing delegate-key entry/);
  });

  it("surfaces a coordinator rejection", async () => {
    const standingKey = await generateEphemeralDelegatedPublicKeyCbor();
    const { request } = fakeRequest({
      standingKeyB64: bytesToBase64(standingKey),
      postStatus: 400,
    });
    const rootKeyPair = await generateEs256RootKeyPair();
    await expect(
      signAdvanceDelegation({
        request,
        coordinatorUrl: "https://coord.test",
        logId: LOG_HEX32,
        logIdHex32: LOG_HEX32,
        rootKeyPair,
        horizonMmrEnd: 100,
      }),
    ).rejects.toThrow(/POST advance delegation: 400/);
  });
});

// hex32ToWireLogId is exercised indirectly by the e2e; keep a smoke assertion
// so an unused-import lint never masks a real break.
describe("hex32ToWireLogId", () => {
  it("produces 16 bytes", () => {
    expect(hex32ToWireLogId(LOG_HEX32)).toHaveLength(16);
  });
});
