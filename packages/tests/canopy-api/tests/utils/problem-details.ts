import type { APIResponse, TestInfo } from "@playwright/test";
import cbor from "cbor";

export type ProblemDetails = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
};

const ATTACHMENT_NAME = "problem-details";

export async function decodeProblemDetails(
  response: APIResponse,
): Promise<ProblemDetails | undefined> {
  if (response.status() < 400) {
    return undefined;
  }

  try {
    const body = await response.body();
    if (!body || body.length === 0) {
      return undefined;
    }

    const decoded = (await cbor.decodeFirst(body)) as ProblemDetails;
    return decoded;
  } catch (error) {
    console.warn(
      "[canopy-api-e2e] Failed to decode CBOR problem details payload",
      error,
    );
    return undefined;
  }
}

export async function reportProblemDetails(
  response: APIResponse,
  testInfo?: TestInfo,
): Promise<ProblemDetails | undefined> {
  const problemDetails = await decodeProblemDetails(response);
  if (!problemDetails) {
    return undefined;
  }

  const formatted = JSON.stringify(problemDetails, null, 2);

  if (testInfo) {
    await testInfo.attach(ATTACHMENT_NAME, {
      contentType: "application/json",
      body: Buffer.from(formatted, "utf-8"),
    });
  }

  console.error(
    "[canopy-api-e2e] Problem Details response detected\n",
    formatted,
  );

  return problemDetails;
}

export function formatProblemDetailsMessage(
  problemDetails?: ProblemDetails,
): string | undefined {
  if (!problemDetails) {
    return undefined;
  }

  const { title, detail, type, instance, status, ...rest } = problemDetails;
  const summaryParts = [
    title ? `title=${title}` : undefined,
    detail ? `detail=${detail}` : undefined,
    type ? `type=${type}` : undefined,
    instance ? `instance=${instance}` : undefined,
    typeof status === "number" ? `status=${status}` : undefined,
  ].filter(Boolean);

  const summary = summaryParts.length
    ? summaryParts.join(" | ")
    : "Problem Details response";

  const extras =
    Object.keys(rest).length > 0
      ? `\nAdditional fields: ${JSON.stringify(rest)}`
      : "";

  return `[canopy-api-e2e] ${summary}${extras}`;
}

