/**
 * signAdvanceDelegation (FOR-390 phase E): pre-delegate to the sealer's
 * standing key by reading the window-less standing entry (C3) and submitting a
 * wide certificate + on-chain signature. Hermetic — the coordinator HTTP
 * surface is faked; only the kit's read/build/submit wiring is under test.
 */

import { describe, expect, it } from "vitest";
import {
  encodeCborDeterministic,
  signCoseSign1Statement,
} from "@forestrie/encoding";
import {
  bytesToBase64,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
  hex32ToWireLogId,
  signAdvanceDelegation,
} from "../src/coordinator-delegation-helpers.js";

const LOG_HEX32 = "0123456789abcdef0123456789abcdef";

/** Mint a registrar key + a voucher over (sealerId, epoch, delegateKeyBytes). */
async function makeRegistrarVoucher(
  sealerId: string,
  epoch: number,
  delegateKeyBytes: Uint8Array,
): Promise<{ pinnedB64: string; voucherB64: string }> {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const payload = encodeCborDeterministic(
    new Map<number, unknown>([
      [1, sealerId],
      [2, epoch],
      [3, delegateKeyBytes],
    ]),
  );
  const voucher = await signCoseSign1Statement(
    payload,
    new Uint8Array([0xab]),
    kp.privateKey,
    { alg: -7 },
  );
  return {
    pinnedB64: bytesToBase64(raw.slice(1)), // x||y
    voucherB64: bytesToBase64(voucher),
  };
}

interface CapturedPost {
  url: string;
  data: Record<string, unknown>;
}

function fakeRequest(opts: {
  standingKeyB64: string | null;
  postStatus?: number;
  voucher?: string;
  sealerId?: string;
  epoch?: number;
}) {
  const posts: CapturedPost[] = [];
  const entries = opts.standingKeyB64
    ? [
        {
          delegatedPublicKey: opts.standingKeyB64,
          suggestedTtlSeconds: 3600,
          ...(opts.voucher !== undefined ? { voucher: opts.voucher } : {}),
          ...(opts.sealerId !== undefined ? { sealerId: opts.sealerId } : {}),
          ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
        },
      ]
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

  it("Phase I: verifies the registrar voucher and binds", async () => {
    const standingKey = await generateEphemeralDelegatedPublicKeyCbor();
    const standingKeyB64 = bytesToBase64(standingKey);
    const { pinnedB64, voucherB64 } = await makeRegistrarVoucher(
      "sealer-a",
      1,
      standingKey,
    );
    const { request, posts } = fakeRequest({
      standingKeyB64,
      voucher: voucherB64,
      sealerId: "sealer-a",
      epoch: 1,
    });
    const rootKeyPair = await generateEs256RootKeyPair();

    const result = await signAdvanceDelegation({
      request,
      coordinatorUrl: "https://coord.test",
      logId: LOG_HEX32,
      logIdHex32: LOG_HEX32,
      rootKeyPair,
      horizonMmrEnd: 65535,
      pinnedRegistrarKey: pinnedB64,
    });
    expect(result.delegatedPublicKey).toBe(standingKeyB64);
    expect(posts).toHaveLength(1);
  });

  it("Phase I: refuses to bind when the voucher does not verify", async () => {
    const standingKey = await generateEphemeralDelegatedPublicKeyCbor();
    const { voucherB64 } = await makeRegistrarVoucher("sealer-a", 1, standingKey);
    // A DIFFERENT pinned key than the one that signed the voucher.
    const wrong = await makeRegistrarVoucher("x", 1, standingKey);
    const { request, posts } = fakeRequest({
      standingKeyB64: bytesToBase64(standingKey),
      voucher: voucherB64,
      sealerId: "sealer-a",
      epoch: 1,
    });
    const rootKeyPair = await generateEs256RootKeyPair();

    await expect(
      signAdvanceDelegation({
        request,
        coordinatorUrl: "https://coord.test",
        logId: LOG_HEX32,
        logIdHex32: LOG_HEX32,
        rootKeyPair,
        horizonMmrEnd: 65535,
        pinnedRegistrarKey: wrong.pinnedB64,
      }),
    ).rejects.toThrow(/refusing to bind/);
    expect(posts).toHaveLength(0); // never submitted
  });

  it("Phase I: refuses to bind when the standing entry has no voucher", async () => {
    const standingKey = await generateEphemeralDelegatedPublicKeyCbor();
    const { pinnedB64 } = await makeRegistrarVoucher("sealer-a", 1, standingKey);
    const { request } = fakeRequest({
      standingKeyB64: bytesToBase64(standingKey),
    }); // no voucher advertised
    const rootKeyPair = await generateEs256RootKeyPair();

    await expect(
      signAdvanceDelegation({
        request,
        coordinatorUrl: "https://coord.test",
        logId: LOG_HEX32,
        logIdHex32: LOG_HEX32,
        rootKeyPair,
        horizonMmrEnd: 65535,
        pinnedRegistrarKey: pinnedB64,
      }),
    ).rejects.toThrow(/missing its registrar voucher/);
  });
});

// hex32ToWireLogId is exercised indirectly by the e2e; keep a smoke assertion
// so an unused-import lint never masks a real break.
describe("hex32ToWireLogId", () => {
  it("produces 16 bytes", () => {
    expect(hex32ToWireLogId(LOG_HEX32)).toHaveLength(16);
  });
});
