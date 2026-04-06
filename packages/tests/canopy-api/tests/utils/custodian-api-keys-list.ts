/**
 * GET /v1/api/keys/list (query labels) and POST /v1/api/keys/list (CBOR body).
 */

import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";
import {
  custodianBodyPreview,
  custodianDecodeCbor,
  custodianReadCborStringField,
} from "./custodian-api-cbor.js";
import { custodianApiV1BaseUrl } from "./custodian-api-env.js";

export interface CustodianApiKeyListEntry {
  keyId: string;
  version: number;
  count?: number;
}

export interface CustodianApiListKeysResponse {
  keys: CustodianApiKeyListEntry[];
}

function readFiniteNumber(raw: unknown, field: string): number | undefined {
  let v: unknown;
  if (raw instanceof Map) {
    v = raw.get(field);
  } else if (raw && typeof raw === "object" && !(raw instanceof Uint8Array)) {
    v = (raw as Record<string, unknown>)[field];
  } else return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

function parseListEntry(raw: unknown): CustodianApiKeyListEntry | null {
  const keyId = custodianReadCborStringField(raw, "keyId");
  const version = readFiniteNumber(raw, "version");
  if (!keyId || version === undefined) return null;
  const count = readFiniteNumber(raw, "count");
  return count === undefined ? { keyId, version } : { keyId, version, count };
}

function parseListKeysResponse(buf: Uint8Array): CustodianApiListKeysResponse {
  const raw = custodianDecodeCbor(buf);
  const keys: CustodianApiKeyListEntry[] = [];
  let arr: unknown[] | null = null;
  if (raw instanceof Map) {
    const k = raw.get("keys");
    arr = Array.isArray(k) ? k : null;
  } else if (raw && typeof raw === "object" && !(raw instanceof Uint8Array)) {
    const k = (raw as Record<string, unknown>).keys;
    arr = Array.isArray(k) ? k : null;
  }
  if (!arr) {
    throw new Error("Custodian list keys: missing keys array");
  }
  for (const e of arr) {
    const entry = parseListEntry(e);
    if (entry) keys.push(entry);
  }
  return { keys };
}

export async function getCustodianApiKeysListGet(opts: {
  baseUrl: string;
  appToken: string;
  /** Query parameters become label filters (e.g. `fo-log_id`). */
  labels: Record<string, string>;
  predicate?: "and" | "or";
}): Promise<CustodianApiListKeysResponse> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.labels)) {
    params.set(k, v);
  }
  if (opts.predicate) params.set("predicate", opts.predicate);
  const res = await fetch(`${base}/api/keys/list?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      Accept: "application/cbor",
    },
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(
      `Custodian list keys (GET): ${res.status} ${custodianBodyPreview(buf)}`,
    );
  }
  return parseListKeysResponse(buf);
}

export async function postCustodianApiKeysList(opts: {
  baseUrl: string;
  appToken: string;
  labels: Record<string, string>;
  predicate?: "and" | "or";
}): Promise<CustodianApiListKeysResponse> {
  const base = custodianApiV1BaseUrl(opts.baseUrl);
  const body: Record<string, unknown> = { labels: opts.labels };
  if (opts.predicate) body.predicate = opts.predicate;
  const encoded = encodeCbor(body);
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/keys/list`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.appToken}`,
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    },
    body: bodyBuf,
  });
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(
      `Custodian list keys (POST): ${res.status} ${custodianBodyPreview(buf)}`,
    );
  }
  return parseListKeysResponse(buf);
}
