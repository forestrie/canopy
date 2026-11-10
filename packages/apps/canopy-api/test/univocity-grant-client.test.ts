/**
 * Univocity grant client (plan-0029): the {@link createUnivocityGrantValidator}
 * production seam posts a creation grant to univocity `POST /api/grants` and maps
 * the HTTP status to a {@link UnivocityGrantResult}. These tests mock `fetch` to
 * assert the request shape (URL, bearer auth, CBOR body) and the status mapping:
 * 201/200 -> accepted, 409 -> conflict, 401/403 -> unavailable, other 4xx ->
 * rejected, 5xx/throw -> unavailable.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeCborDeterministic } from "@forestrie/encoding";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import {
  createUnivocityGrantValidator,
  reserveChildGrantWithUnivocity,
} from "../src/scrapi/univocity-grant-client.js";

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

/** univocity's claim answer (`postGrantResponse`), CBOR. */
function claimAnswer(fields: Record<string, unknown>): Response {
  return new Response(encodeCborDeterministic(fields) as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": "application/cbor" },
  });
}

/** 2xx answers carry a committed claim; others a problem+json body. */
function spyFetch(status: number, title = "invalid grant") {
  const body =
    status >= 200 && status < 300
      ? (encodeCborDeterministic({ state: "committed" }) as unknown as BodyInit)
      : JSON.stringify({ type: "about:blank", title, status });
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(body, { status }));
}

describe("createUnivocityGrantValidator", () => {
  it("posts CBOR {rootLogId, statement, intent: commit} with bearer auth to /api/grants", async () => {
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
      intent: string;
    };
    expect(Array.from(decoded.rootLogId)).toEqual(Array.from(rootLogId()));
    expect(Array.from(decoded.statement)).toEqual(Array.from(statementBytes()));
    expect(decoded.intent).toBe("commit");
  });

  it("201 -> accepted (created)", async () => {
    spyFetch(201);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r).toEqual({ kind: "accepted", created: true, state: "committed" });
  });

  it("200 -> accepted (idempotent, not created)", async () => {
    spyFetch(200);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r).toEqual({
      kind: "accepted",
      created: false,
      state: "committed",
    });
  });

  it("409 -> conflict, carrying univocity's problem title", async () => {
    spyFetch(409, "grant-already-claimed");
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r).toMatchObject({
      kind: "conflict",
      title: "grant-already-claimed",
    });
  });

  it("an accepted answer univocity did not encode is unavailable, never a claim", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not cbor", { status: 201 }),
    );
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r.kind).toBe("unavailable");
  });

  it("422 -> rejected with status", async () => {
    spyFetch(422);
    const r = await createUnivocityGrantValidator(CLIENT).validate(
      rootLogId(),
      statementBytes(),
    );
    expect(r).toMatchObject({ kind: "rejected", status: 422 });
  });

  it.each([401, 403])(
    "%i (univocity refused canopy's own credentials) -> unavailable, never a verdict on the grant",
    async (status) => {
      spyFetch(status);
      const r = await createUnivocityGrantValidator(CLIENT).validate(
        rootLogId(),
        statementBytes(),
      );
      expect(r.kind).toBe("unavailable");
    },
  );

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

describe("reserveChildGrantWithUnivocity", () => {
  it("posts {statement, intent: reserve} with no rootLogId and returns the reservation's expiresAt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        claimAnswer({ state: "reserved", expiresAt: 1_900_000_000 }),
      );
    const r = await reserveChildGrantWithUnivocity(CLIENT, statementBytes());

    expect(r).toEqual({
      kind: "accepted",
      created: false,
      state: "reserved",
      expiresAt: 1_900_000_000,
    });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://univocity.test/api/grants");
    const decoded = decodeCborAsObject(
      new Uint8Array(init.body as ArrayBuffer),
    ) as Record<string, unknown>;
    expect(decoded.intent).toBe("reserve");
    expect("rootLogId" in decoded).toBe(false);
  });

  it("a reservation answered without its lapse time is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      claimAnswer({ state: "reserved" }),
    );
    const r = await reserveChildGrantWithUnivocity(CLIENT, statementBytes());
    expect(r.kind).toBe("unavailable");
  });
});
