import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeCborDeterministic as encodeCbor } from "@forestrie/encoding";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runIdFile = resolve(__dirname, ".e2e-run-id");

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
}

function v1Base(raw: string): string {
  const u = new URL(trimBase(raw));
  return `${u.protocol}//${u.host}/v1`;
}

function getRunId(): string | null {
  const fromEnv = process.env.E2E_RUN_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(runIdFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function keysFrom(decoded: unknown): Array<Record<string, unknown>> {
  let keys: unknown;
  if (decoded instanceof Map) keys = decoded.get("keys");
  else keys = (decoded as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.map((e) => {
    if (e instanceof Map) {
      return {
        keyId: e.get("keyId"),
        version: e.get("version"),
        count: e.get("count"),
      };
    }
    return e as Record<string, unknown>;
  });
}

/**
 * Best-effort delete of per-run custody keys (labeled e2e-run-id + e2e-test-key).
 * Never fails the Playwright exit code. Skipped when env vars are missing or
 * E2E_SKIP_CUSTODIAN_KEY_CLEANUP=1.
 */
export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_SKIP_CUSTODIAN_KEY_CLEANUP === "1") {
    console.warn(
      "[e2e teardown] skipping custodian key cleanup (E2E_SKIP_CUSTODIAN_KEY_CLEANUP=1)",
    );
    return;
  }

  const runId = getRunId();
  const baseUrl = process.env.CUSTODIAN_URL?.trim();
  const appToken = process.env.CUSTODIAN_APP_TOKEN?.trim();
  const bootstrap = process.env.CUSTODIAN_BOOTSTRAP_APP_TOKEN?.trim();

  if (!runId || !baseUrl || !appToken || !bootstrap) {
    console.warn(
      "[e2e teardown] skipping custodian key cleanup (need E2E_RUN_ID, CUSTODIAN_URL, CUSTODIAN_APP_TOKEN, CUSTODIAN_BOOTSTRAP_APP_TOKEN)",
    );
    return;
  }

  const listUrl = `${v1Base(baseUrl)}/api/keys/list`;
  let listed: Array<Record<string, unknown>> = [];
  try {
    const encoded = encodeCbor({
      labels: { "e2e-run-id": runId, "e2e-test-key": "true" },
      predicate: "and",
    });
    const u8 =
      encoded instanceof Uint8Array
        ? encoded
        : new Uint8Array(encoded as ArrayLike<number>);
    const bodyBuf = u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength,
    ) as ArrayBuffer;
    const res = await fetch(listUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appToken}`,
        "Content-Type": "application/cbor",
        Accept: "application/cbor",
      },
      body: bodyBuf,
    });
    if (!res.ok) {
      console.warn(`[e2e teardown] list keys HTTP ${res.status}`);
      return;
    }
    const { decodeCborDeterministic: decodeCbor } = await import(
      "@forestrie/encoding"
    );
    listed = keysFrom(decodeCbor(new Uint8Array(await res.arrayBuffer())));
  } catch (err) {
    console.warn("[e2e teardown] list keys failed:", err);
    return;
  }

  let deleted = 0;
  let failed = 0;
  for (const row of listed) {
    const keyId = row.keyId;
    if (typeof keyId !== "string" || !keyId) continue;
    try {
      const seg = encodeURIComponent(keyId);
      const delUrl = `${v1Base(baseUrl)}/api/keys/${seg}/delete`;
      const dres = await fetch(delUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrap}`,
          Accept: "application/cbor",
        },
      });
      if (dres.ok) {
        deleted++;
      } else {
        failed++;
        console.warn(`[e2e teardown] delete ${keyId} HTTP ${dres.status}`);
      }
    } catch (err) {
      failed++;
      console.warn(`[e2e teardown] delete ${keyId} error:`, err);
    }
  }

  console.warn(
    `[e2e teardown] custodian keys for run ${runId}: listed ${listed.length}, deleted ${deleted}, failed ${failed}`,
  );
}
