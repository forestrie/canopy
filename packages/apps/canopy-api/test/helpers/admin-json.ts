import { expect } from "vitest";
import type { AdminJsonProblemBody } from "../../src/cbor-api/admin-json-response.js";

export function adminAuthHeaders(
  token: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

export async function expectAdminJsonProblem(
  res: Response,
  expectedStatus: number,
  detailIncludes?: string,
): Promise<AdminJsonProblemBody> {
  expect(res.status).toBe(expectedStatus);
  expect(res.headers.get("content-type")).toContain("application/json");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as AdminJsonProblemBody;
  expect(body.status).toBe(expectedStatus);
  expect(typeof body.title).toBe("string");
  if (detailIncludes) {
    expect(body.detail).toContain(detailIncludes);
  }
  return body;
}
