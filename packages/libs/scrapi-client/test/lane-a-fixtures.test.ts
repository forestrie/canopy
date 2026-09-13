import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  queryRegistrationOnce,
  queryRegistrationRaw,
  resolveReceiptOnce,
  resolveReceiptRaw,
} from "../src/index.js";

/**
 * Replays recorded lane-A exchanges through the `*Raw` and parsed poll-once
 * functions via a fake fetch — no real network request. Fixtures are copied
 * byte-for-byte from mcp-resolve's `test/fixtures/lane-a/` (plan-2609-05
 * step 2.1 capture); see `fixtures/lane-a/PROVENANCE.md` for what each
 * exchange shows and why. Frozen: a new capture is an orchestrator-authorised
 * runner step, never a worker fetch (plan-2609-07 step 1.3, FOR-559).
 */

const FIXTURES_DIR = fileURLToPath(
  new URL("./fixtures/lane-a/", import.meta.url),
);
const BASE = "https://api-a.forest-2.forestrie.dev";

interface FixtureMeta {
  url: string;
  status: number;
  headers: Record<string, string>;
}

function fixturePath(name: string): string {
  return `${FIXTURES_DIR}${name}`;
}

function readMeta(name: string): FixtureMeta {
  return JSON.parse(readFileSync(fixturePath(`${name}.meta.json`), "utf8"));
}

function readBinary(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)));
}

/** Fake fetch that answers with the recorded status/headers/body for one fixture. */
function fixtureFetch(meta: FixtureMeta, body?: Uint8Array): typeof fetch {
  return (async () =>
    new Response((body ?? null) as BodyInit | null, {
      status: meta.status,
      headers: meta.headers,
    })) as typeof fetch;
}

describe("lane-A fixtures manifest", () => {
  it("matches the sha256 of every copied binary fixture", () => {
    const manifest = JSON.parse(
      readFileSync(fixturePath("manifest.json"), "utf8"),
    ) as { files: Record<string, string> };
    for (const name of ["receipt-self.cbor"]) {
      const sha256 = createHash("sha256")
        .update(readFileSync(fixturePath(name)))
        .digest("hex");
      expect(sha256).toBe(manifest.files[name]);
    }
  });
});

describe("lane-A fixture replay: status-self (303 -> receipt)", () => {
  const meta = readMeta("status-self");

  it("queryRegistrationRaw returns the raw 303 exchange", async () => {
    const raw = await queryRegistrationRaw({
      statusUrl: meta.url,
      fetchImpl: fixtureFetch(meta),
    });
    expect(raw.url).toBe(meta.url);
    expect(raw.status).toBe(303);
    expect(raw.headers["location"]).toBe(meta.headers["location"]);
    expect(raw.body).toEqual(new Uint8Array(0));
    expect(raw.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("queryRegistrationOnce resolves to the permanent receipt URL", async () => {
    const out = await queryRegistrationOnce({
      statusUrl: meta.url,
      baseUrl: BASE,
      fetchImpl: fixtureFetch(meta),
    });
    expect(out).toEqual({
      status: "receipt",
      receiptUrl: meta.headers["location"],
      entryIdHex: "a09a6337ee0009000000000000000008",
    });
  });
});

describe("lane-A fixture replay: status-unknown (303 -> pending)", () => {
  const meta = readMeta("status-unknown");

  it("queryRegistrationOnce reports pending with the recorded Retry-After", async () => {
    const out = await queryRegistrationOnce({
      statusUrl: meta.url,
      baseUrl: BASE,
      fetchImpl: fixtureFetch(meta),
    });
    expect(out).toEqual({
      status: "pending",
      location: meta.headers["location"],
      retryAfterMs: 1000,
    });
  });
});

describe("lane-A fixture replay: receipt-self (200 -> receipt)", () => {
  const meta = readMeta("receipt-self");
  const body = readBinary("receipt-self.cbor");

  it("resolveReceiptRaw returns the raw 200 exchange with the receipt bytes", async () => {
    const raw = await resolveReceiptRaw({
      receiptUrl: meta.url,
      fetchImpl: fixtureFetch(meta, body),
    });
    expect(raw.url).toBe(meta.url);
    expect(raw.status).toBe(200);
    expect(raw.headers["content-type"]).toBe("application/scitt-receipt+cbor");
    expect(raw.body).toEqual(body);
    expect(raw.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("resolveReceiptOnce returns the receipt body", async () => {
    const out = await resolveReceiptOnce({
      receiptUrl: meta.url,
      fetchImpl: fixtureFetch(meta, body),
    });
    expect(out.status).toBe("receipt");
    if (out.status === "receipt") {
      expect(out.httpStatus).toBe(200);
      expect(out.body).toEqual(body);
      expect(out.headers["content-type"]).toBe(
        "application/scitt-receipt+cbor",
      );
    }
  });
});
