import { encodeCborDeterministic } from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  MAX_DETAIL_LENGTH,
  logProblemResponse,
  problemFieldsFromResponse,
  routePattern,
  type ProblemLogEntry,
} from "../src/index.js";

function capture(): {
  lines: { level: string; entry: ProblemLogEntry }[];
  log: { warn: (s: string) => void; error: (s: string) => void };
} {
  const lines: { level: string; entry: ProblemLogEntry }[] = [];
  return {
    lines,
    log: {
      warn: (s: string) => lines.push({ level: "warn", entry: JSON.parse(s) }),
      error: (s: string) =>
        lines.push({ level: "error", entry: JSON.parse(s) }),
    },
  };
}

const cborProblem = (
  status: number,
  title: string,
  detail?: string,
  contentType = "application/problem+cbor",
) =>
  new Response(
    encodeCborDeterministic({
      type: "about:blank",
      title,
      status,
      ...(detail ? { detail } : {}),
    }) as unknown as BodyInit,
    { status, headers: { "content-type": contentType } },
  );

describe("routePattern", () => {
  it("masks identifier-like segments only", () => {
    expect(
      routePattern("/api/forest/e22c8d553f88b2b5f2255d2c2441bcdd/genesis"),
    ).toBe("/api/forest/{id}/genesis");
    expect(
      routePattern("/api/logs/e22c8d55-3f88-b2b5-f225-5d2c2441bcdd/delegation"),
    ).toBe("/api/logs/{id}/delegation");
    expect(
      routePattern(
        "/api/instances/eip155:84532:0xE22c8D553F88B2b5f2255d2C2441bCdd0D50Cd58/webhook",
      ),
    ).toBe("/api/instances/{id}/webhook");
    expect(routePattern("/entries/12345")).toBe("/entries/{id}");
    expect(routePattern("/api/health")).toBe("/api/health");
    expect(routePattern("/.well-known/scitt-configuration")).toBe(
      "/.well-known/scitt-configuration",
    );
  });
});

describe("problemFieldsFromResponse", () => {
  it("reads application/problem+cbor and application/cbor bodies", async () => {
    expect(
      await problemFieldsFromResponse(
        cborProblem(400, "Bad Request", "Invalid CBOR body"),
      ),
    ).toEqual({
      type: "about:blank",
      title: "Bad Request",
      detail: "Invalid CBOR body",
    });
    expect(
      await problemFieldsFromResponse(
        cborProblem(400, "Bad Request", "x", "application/cbor"),
      ),
    ).toMatchObject({
      title: "Bad Request",
      detail: "x",
    });
  });

  it("reads application/problem+json and text bodies", async () => {
    const json = Response.json(
      {
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "bearer missing",
      },
      { status: 401, headers: { "content-type": "application/problem+json" } },
    );
    expect(await problemFieldsFromResponse(json)).toEqual({
      type: "about:blank",
      title: "Unauthorized",
      detail: "bearer missing",
    });
    const text = new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
    expect(await problemFieldsFromResponse(text)).toEqual({
      detail: "Not Found",
    });
  });

  it("yields no fields for a body that does not decode, and leaves the body readable", async () => {
    const broken = new Response(new Uint8Array([0xff, 0xff]), {
      status: 400,
      headers: { "content-type": "application/cbor" },
    });
    expect(await problemFieldsFromResponse(broken)).toEqual({});
    expect(new Uint8Array(await broken.arrayBuffer())).toEqual(
      new Uint8Array([0xff, 0xff]),
    );
  });
});

describe("logProblemResponse", () => {
  const request = new Request(
    "https://api.example.dev/api/forest/e22c8d553f88b2b5f2255d2c2441bcdd/genesis?webhookUrl=x",
    {
      method: "POST",
      headers: { "cf-ray": "9a1b2c3d4e5f6a7b-LHR" },
    },
  );

  it("writes exactly one warn line for a 400, with method, route, status, title, detail and ray", async () => {
    const { lines, log } = capture();
    const response = cborProblem(400, "Bad Request", "Invalid CBOR body");
    const returned = await logProblemResponse(request, response, {
      service: "canopy-api",
      log,
    });
    expect(returned).toBe(response);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.entry).toEqual({
      event: "problem_response",
      level: "warn",
      service: "canopy-api",
      method: "POST",
      path: "/api/forest/e22c8d553f88b2b5f2255d2c2441bcdd/genesis",
      route: "/api/forest/{id}/genesis",
      status: 400,
      type: "about:blank",
      title: "Bad Request",
      detail: "Invalid CBOR body",
      ray: "9a1b2c3d4e5f6a7b-LHR",
    });
    // the body is still readable by the client
    expect(await returned.arrayBuffer()).toBeInstanceOf(ArrayBuffer);
  });

  it("writes an error line for a 5xx and nothing for a 2xx", async () => {
    const { lines, log } = capture();
    await logProblemResponse(
      request,
      cborProblem(503, "Service Unavailable", "queue paused"),
      { log },
    );
    await logProblemResponse(request, new Response("ok", { status: 200 }), {
      log,
    });
    await logProblemResponse(
      request,
      new Response(null, { status: 303, headers: { Location: "/x" } }),
      { log },
    );
    expect(lines.map((l) => l.level)).toEqual(["error"]);
    expect(lines[0]!.entry.status).toBe(503);
  });

  it("omits ray when the request did not come through Cloudflare, and clips long detail", async () => {
    const { lines, log } = capture();
    const plain = new Request("https://api.example.dev/entries/42");
    await logProblemResponse(
      plain,
      cborProblem(404, "Not Found", "y".repeat(MAX_DETAIL_LENGTH + 10)),
      { log },
    );
    expect(lines[0]!.entry.ray).toBeUndefined();
    expect(lines[0]!.entry.route).toBe("/entries/{id}");
    expect(lines[0]!.entry.detail!.length).toBe(MAX_DETAIL_LENGTH + 1);
  });

  it("uses the caller's route pattern when given", async () => {
    const { lines, log } = capture();
    await logProblemResponse(request, cborProblem(409, "Conflict"), {
      route: "/api/forest/:logId/genesis",
      log,
    });
    expect(lines[0]!.entry.route).toBe("/api/forest/:logId/genesis");
    expect(lines[0]!.entry.detail).toBeUndefined();
  });
});
