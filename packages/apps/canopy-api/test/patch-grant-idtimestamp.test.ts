/**
 * Unit tests for patchGrantIdtimestamp (univocity grant-store update after sequencing).
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { patchGrantIdtimestamp } from "../src/scrapi/patch-grant-idtimestamp.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("patchGrantIdtimestamp", () => {
  it("PATCHes univocity with 8-byte big-endian idtimestamp and returns ok on 204", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await patchGrantIdtimestamp({
      client: {
        serviceUrl: "https://univocity.example",
        token: "tok",
      },
      rootLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      subjectLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      idtimestamp: 0x9f4934abca030500n,
    });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "https://univocity.example/api/forest/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/grants/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/idtimestamp",
    );
    expect(init?.method).toBe("PATCH");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    const body = new Uint8Array(init?.body as ArrayBuffer);
    // CBOR map with key "idtimestamp" and 8-byte value ending with ...ca 03 05 00
    expect(body.length).toBeGreaterThan(8);
    expect(Array.from(body.slice(-8))).toEqual([
      0x9f, 0x49, 0x34, 0xab, 0xca, 0x03, 0x05, 0x00,
    ]);
  });

  it("returns ok:false with status when univocity rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("conflict", { status: 409 })),
    );

    const result = await patchGrantIdtimestamp({
      client: { serviceUrl: "https://univocity.example", token: "tok" },
      rootLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      subjectLogId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      idtimestamp: 1n,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.detail).toContain("conflict");
    }
  });
});
