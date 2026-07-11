/**
 * Poll-once primitive for SCRAPI resolve-receipt: a single GET of the
 * permanent receipt URL. Query-registration-status may 303 to the receipt URL
 * before checkpoint/massif objects exist in R2 (404 = still pending). NO sleep
 * loops here — callers own retry pacing.
 */

export type ReceiptResolution =
  /** 404: MMRS checkpoint/massif may still be writing after sequencing ack. */
  | { status: "pending" }
  /** 200 with the receipt body. */
  | {
      status: "receipt";
      httpStatus: number;
      headers: { [key: string]: string };
      body: Uint8Array;
    }
  /** Any other status: not retryable. */
  | { status: "error"; httpStatus: number };

export interface ResolveReceiptOnceOptions {
  receiptUrl: string;
  /** Defaults to `application/cbor`. */
  accept?: string;
  fetchImpl?: typeof fetch;
}

/** GET resolve-receipt once: 200 receipt, 404 pending, anything else error. */
export async function resolveReceiptOnce(
  opts: ResolveReceiptOnceOptions,
): Promise<ReceiptResolution> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.receiptUrl, {
    headers: { Accept: opts.accept ?? "application/cbor" },
  });
  if (res.status === 200) {
    const headers: { [key: string]: string } = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return {
      status: "receipt",
      httpStatus: res.status,
      headers,
      body: new Uint8Array(await res.arrayBuffer()),
    };
  }
  if (res.status === 404) {
    return { status: "pending" };
  }
  return { status: "error", httpStatus: res.status };
}
