/**
 * Playwright wrapper over the @forestrie/scrapi-client problem-details decode
 * (plan-2607-12 Phase 2, FOR-351).
 */

import type { APIResponse } from "@playwright/test";
import { decodeProblemDetailsBytes } from "@forestrie/scrapi-client";
import type { ProblemDetails } from "@forestrie/scrapi-client";

export type { ProblemDetails };

export async function decodeProblemDetails(
  response: APIResponse,
): Promise<ProblemDetails | undefined> {
  if (response.status() < 400) {
    return undefined;
  }
  try {
    return decodeProblemDetailsBytes(new Uint8Array(await response.body()));
  } catch {
    return undefined;
  }
}
