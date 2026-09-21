/**
 * The human-readable reason a canopy / coordinator request was rejected
 * (FOR-579): RFC 9457 problem details encoded as CBOR (`application/cbor`
 * on most canopy-api routes, `application/problem+cbor` on the SCRAPI ones)
 * or JSON, falling back to the text body. Never throws.
 */
import { decodeCborDeterministic } from "@forestrie/encoding";
import type { APIResponse } from "@playwright/test";

function readString(source: unknown, key: string): string | undefined {
  if (source instanceof Map) {
    const value = source.get(key);
    return typeof value === "string" ? value : undefined;
  }
  if (typeof source === "object" && source !== null) {
    const value = (source as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function describeProblem(decoded: unknown): string | undefined {
  const detail = readString(decoded, "detail");
  const title = readString(decoded, "title");
  if (detail && title) return `${title}: ${detail}`;
  return detail ?? title;
}

/** Problem detail from raw bytes and their content type. */
export function problemDetailFromBytes(
  bytes: Uint8Array,
  contentType: string | undefined,
  max = 300,
): string {
  const ct = (contentType ?? "").toLowerCase();
  let text = "";
  try {
    if (bytes.length === 0) return "";
    if (ct.includes("cbor")) {
      const described = describeProblem(decodeCborDeterministic(bytes));
      if (described) return described.slice(0, max);
    }
    text = new TextDecoder().decode(bytes);
    if (ct.includes("json")) {
      const described = describeProblem(JSON.parse(text));
      if (described) return described.slice(0, max);
    }
  } catch {
    // fall through to whatever text we have
  }
  return text.slice(0, max);
}

/** Problem detail from a Playwright API response. */
export async function problemDetailFromResponse(
  res: APIResponse,
  max = 300,
): Promise<string> {
  const bytes = new Uint8Array(await res.body());
  return problemDetailFromBytes(bytes, res.headers()["content-type"], max);
}
