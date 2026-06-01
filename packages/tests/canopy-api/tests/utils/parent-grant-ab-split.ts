/**
 * A vs B RCA attach for auth-data-log-chain data-grant 403 (plan-0026 / A-B evidence).
 */

import type { APIRequestContext, APIResponse } from "@playwright/test";
import { extractDelegationCertBytes } from "@e2e-canopy-api-src/grant/delegation-verify.js";
import { parseReceipt } from "@e2e-canopy-api-src/grant/receipt-verify.js";
import {
  decodeProblemDetails,
  type ProblemDetails,
} from "./problem-details.js";
import {
  diagnoseCompletedParentGrant,
  type ParentGrantReceiptDiagnostic,
} from "./parent-grant-receipt-diagnostics.js";
import { pollResolveReceiptUntil200 } from "./arithmetic-backoff-poll.js";

export type InferredParentReceiptOutcome =
  | "signature-failed"
  | "inclusion-failed"
  | "signature-failed-inclusion-ok"
  | "no-verify-keys"
  | "legacy-generic"
  | "unknown";

export interface ParentGrantAbSplit extends ParentGrantReceiptDiagnostic {
  registerGrantStatus: number;
  problemDetail: string | null;
  inferredOutcome: InferredParentReceiptOutcome;
  hasDelegationCertOnResolveReceipt: boolean;
  hasDelegationCertOnParentGrantBody: boolean;
  receiptMatchesResolveReceiptBody: boolean;
  rootLogId: string;
  authLogId: string;
  entryIdHex: string;
  receiptUrl: string;
  reFetchResolveReceipt: {
    status: number;
    hasDelegationCert: boolean;
    bodyMatchesOriginal: boolean;
  };
  ciEnvPresent: {
    coordinatorUrl: boolean;
    coordinatorToken: boolean;
    custodianToken: boolean;
  };
  problemExtensions?: Record<string, unknown>;
}

function inferOutcomeFromDetail(
  detail: string | null | undefined,
): InferredParentReceiptOutcome {
  if (!detail) return "unknown";
  if (detail.includes("inclusion proof does not bind"))
    return "inclusion-failed";
  if (detail.includes("but the MMR inclusion proof matches")) {
    return "signature-failed-inclusion-ok";
  }
  if (
    detail.includes("signature did not verify") &&
    detail.includes("delegation cert")
  ) {
    return "signature-failed";
  }
  if (detail.includes("could not resolve signing keys"))
    return "no-verify-keys";
  if (detail.includes("receipt signature or inclusion proof")) {
    return "legacy-generic";
  }
  return "unknown";
}

function hasDelegationCertOnReceiptBody(body: Uint8Array): boolean {
  try {
    const parsed = parseReceipt(body);
    return extractDelegationCertBytes(parsed.coseSign1[1]) != null;
  } catch {
    return false;
  }
}

export async function buildParentGrantAbSplit(opts: {
  registerRes: APIResponse;
  completedGrantBase64: string;
  resolveReceiptBody: Uint8Array;
  entryIdHex: string;
  receiptUrlAbsolute: string;
  rootLogId: string;
  authLogId: string;
  unauthorizedRequest: APIRequestContext;
  ladderMs?: number[];
}): Promise<ParentGrantAbSplit> {
  const problem = await decodeProblemDetails(opts.registerRes);
  const detail = problem?.detail ?? null;
  const extensions =
    problem?.extensions && typeof problem.extensions === "object"
      ? (problem.extensions as Record<string, unknown>)
      : undefined;

  const base = diagnoseCompletedParentGrant({
    completedGrantBase64: opts.completedGrantBase64,
    resolveReceiptBody: opts.resolveReceiptBody,
    entryIdHex: opts.entryIdHex,
  });

  let reFetchStatus = 0;
  let reFetchHasCert = false;
  let reFetchMatches = false;
  try {
    const reFetch = await pollResolveReceiptUntil200({
      request: opts.unauthorizedRequest,
      receiptUrlAbsolute: opts.receiptUrlAbsolute,
      ladderMs: opts.ladderMs ?? [500, 1000, 2000],
      maxWaitMs: 8_000,
    });
    reFetchStatus = reFetch.status;
    reFetchHasCert = hasDelegationCertOnReceiptBody(reFetch.body);
    reFetchMatches =
      reFetch.body.length === opts.resolveReceiptBody.length &&
      reFetch.body.every((b, i) => b === opts.resolveReceiptBody[i]);
  } catch {
    reFetchStatus = 0;
  }

  return {
    ...base,
    registerGrantStatus: opts.registerRes.status(),
    problemDetail: detail,
    inferredOutcome: inferOutcomeFromDetail(detail),
    hasDelegationCertOnResolveReceipt: hasDelegationCertOnReceiptBody(
      opts.resolveReceiptBody,
    ),
    hasDelegationCertOnParentGrantBody: base.hasDelegationCert,
    receiptMatchesResolveReceiptBody: base.receiptMatchesResolveReceiptBody,
    rootLogId: opts.rootLogId,
    authLogId: opts.authLogId,
    entryIdHex: opts.entryIdHex,
    receiptUrl: opts.receiptUrlAbsolute,
    reFetchResolveReceipt: {
      status: reFetchStatus,
      hasDelegationCert: reFetchHasCert,
      bodyMatchesOriginal: reFetchMatches,
    },
    ciEnvPresent: {
      coordinatorUrl: Boolean(process.env.DELEGATION_COORDINATOR_URL?.trim()),
      coordinatorToken: Boolean(process.env.COORDINATOR_APP_TOKEN?.trim()),
      custodianToken: Boolean(process.env.CUSTODIAN_APP_TOKEN?.trim()),
    },
    problemExtensions: extensions,
  };
}

export async function attachParentGrantAbSplit(
  testInfo: {
    attach: (
      name: string,
      opts: { body: string; contentType: string },
    ) => Promise<void>;
  },
  split: ParentGrantAbSplit,
  registerRes: APIResponse,
): Promise<void> {
  await testInfo.attach("parent-grant-ab-split.json", {
    body: JSON.stringify(split, null, 2),
    contentType: "application/json",
  });
  try {
    const body = await registerRes.body();
    if (body.length > 0) {
      await testInfo.attach("parent-grant-403.cbor.b64", {
        body: Buffer.from(body).toString("base64"),
        contentType: "text/plain",
      });
    }
  } catch {
    // response body may already be consumed
  }
}

export function problemDetailFromRegisterError(
  error: unknown,
): ProblemDetails | undefined {
  if (
    error &&
    typeof error === "object" &&
    "problem" in error &&
    (error as { problem?: ProblemDetails }).problem
  ) {
    return (error as { problem: ProblemDetails }).problem;
  }
  return undefined;
}
