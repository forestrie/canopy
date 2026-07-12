/**
 * Univocity grant client (plan-0029): the {@link createUnivocityGrantValidator}
 * production seam posts a creation grant to univocity `POST /api/grants` and maps
 * the HTTP status to a {@link UnivocityGrantResult}. These tests mock `fetch` to
 * assert the request shape (URL, bearer auth, CBOR body) and the status mapping:
 * 201/200 -> accepted, 409 -> conflict, 4xx -> rejected, 5xx/throw -> unavailable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { createUnivocityGrantValidator } from "../src/scrapi/univocity-grant-client.js";

const CLIENT = { serviceUrl: "https://univocity.test", token: "tok" };

afterEach(() => {
  vi.restoreAllMocks();
});

function rootLogId(): Uint8Array {
  return new Uint8Array(16).fill(0x11);
}

function statementBytes(): Uint8Array {
  return new Uint8Array([0xa1, 0x02, 0x03, 0x04]);
}

function spyFetch(status: number) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("detail body", { status }));
}

describe("createUnivocityGrantValidator", () => {
  it("posts CBOR {rootLogId, statement} with bearer auth to /api/grants", async () => {
    const fetchSpy = spyFetch(201);
    await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://univocity.test/api/grants");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/cbor");
    const decoded = decodeCborAsObject(
      new Uint8Array(init.body as ArrayBuffer),
    ) as {
      rootLogId: Uint8Array;
      statement: Uint8Array;
    };
    expect(Array.from(decoded.rootLogId)).toEqual(Array.from(rootLogId()));
    expect(Array.from(decoded.statement)).toEqual(Array.from(statementBytes()));
  });

  it("201 -> accepted (created)", async () => {
    spyFetch(201);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r).toEqual({ kind: "accepted", created: true });
  });

  it("200 -> accepted (idempotent, not created)", async () => {
    spyFetch(200);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r).toEqual({ kind: "accepted", created: false });
  });

  it("409 -> conflict", async () => {
    spyFetch(409);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r.kind).toBe("conflict");
  });

  it("422 -> rejected with status", async () => {
    spyFetch(422);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r).toMatchObject({ kind: "rejected", status: 422 });
  });

  it("503 -> unavailable", async () => {
    spyFetch(503);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r.kind).toBe("unavailable");
  });

  it("network error -> unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r.kind).toBe("unavailable");
  });
});
