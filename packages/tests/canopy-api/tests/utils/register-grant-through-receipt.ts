import type { APIRequestContext } from "@playwright/test";
import {
  pollQueryRegistrationUntilReceiptRedirect,
  pollResolveReceiptUntil200,
  sequencingBackoff,
} from "./arithmetic-backoff-poll";
import { postRegisterGrantExpect303 } from "./bootstrap-grant-setup";

export interface CompleteGrantRegistrationThroughReceiptOptions {
  unauthorizedRequest: APIRequestContext;
  /** First path segment after `/logs/` — forest bootstrap log id (UUID). */
  bootstrapLogId: string;
  baseURL: string;
  grantBase64: string;
  ladderMs?: number[];
  pollRegistrationMaxMs?: number;
  resolveReceiptMaxMs?: number;
}

export interface CompleteGrantRegistrationThroughReceiptResult {
  statusUrlAbsolute: string;
  receiptUrlAbsolute: string;
  entryIdHex: string;
  grantBase64: string;
  receiptRes: Awaited<ReturnType<typeof pollResolveReceiptUntil200>>;
}

/**
 * POST register-grant (303), poll until receipt redirect, GET receipt until 200.
 */
export async function completeGrantRegistrationThroughReceipt(
  opts: CompleteGrantRegistrationThroughReceiptOptions,
): Promise<CompleteGrantRegistrationThroughReceiptResult> {
  const { statusUrlAbsolute } = await postRegisterGrantExpect303(
    opts.unauthorizedRequest,
    {
      bootstrapLogId: opts.bootstrapLogId,
      baseURL: opts.baseURL,
      grantBase64: opts.grantBase64,
    },
  );

  const ladder = opts.ladderMs ?? sequencingBackoff;
  const { receiptUrlAbsolute, entryIdHex } =
    await pollQueryRegistrationUntilReceiptRedirect({
      request: opts.unauthorizedRequest,
      statusUrlAbsolute,
      baseURL: opts.baseURL,
      ladderMs: ladder,
      maxWaitMs: opts.pollRegistrationMaxMs ?? 180_000,
    });

  const receiptRes = await pollResolveReceiptUntil200({
    request: opts.unauthorizedRequest,
    receiptUrlAbsolute,
    ladderMs: ladder,
    maxWaitMs: opts.resolveReceiptMaxMs ?? 420_000,
  });

  return {
    statusUrlAbsolute,
    receiptUrlAbsolute,
    entryIdHex,
    grantBase64: opts.grantBase64,
    receiptRes,
  };
}
