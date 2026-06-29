import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect } from "@playwright/test";

const COSE_SIGN1_CONTENT_TYPE = 'application/cose; cose-type="cose-sign1"';

export async function postLogEntriesCoseSign1(
  request: APIRequestContext,
  opts: {
    bootstrapLogId: string;
    logId: string;
    completedGrantB64: string;
    sign1Bytes: Uint8Array;
  },
): Promise<APIResponse> {
  return request.post(`/register/${opts.bootstrapLogId}/entries`, {
    headers: {
      Authorization: `Forestrie-Grant ${opts.completedGrantB64}`,
      "content-type": COSE_SIGN1_CONTENT_TYPE,
    },
    data: Buffer.from(opts.sign1Bytes),
    maxRedirects: 0,
  });
}

export function assert303ContentHashLocation(opts: {
  bootstrapLogId: string;
  logId: string;
  baseURL: string;
  location: string | undefined;
  contentHashHexLower: string;
}): void {
  expect(
    opts.location,
    "303 must include Location with content hash",
  ).toBeTruthy();
  let absolute = opts.location!;
  if (!absolute.startsWith("http")) {
    absolute = `${opts.baseURL}${absolute.startsWith("/") ? "" : "/"}${absolute}`;
  }
  expect(absolute.toLowerCase()).toContain(
    `/logs/${opts.bootstrapLogId}/${opts.logId}/entries/${opts.contentHashHexLower}`.toLowerCase(),
  );
}
