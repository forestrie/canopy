/**
 * Raw HTTP exchange capture shared by every network function in this
 * package. Each function's `*Raw` variant (e.g. {@link
 * queryRegistrationRaw}, {@link resolveReceiptRaw}) returns one of these for
 * EVERY response status — no throwing, no status interpretation — so the
 * package's own parsed `*Once` functions, and callers who need the wire
 * facts directly, build on the same evidence. See plan-2609-07 decision L2
 * (forestrie/devdocs `plans/plan-2609-07-forestrie-client-libs-provenance/decisions.md`).
 */

export type RawResponse = {
  /**
   * The request URL. Not `Response.url`: fetch leaves that unset on some
   * runtimes/mocks for a manual-redirect response, so the URL passed to
   * `fetch` is used instead.
   */
  url: string;
  status: number;
  /** Every response header, lower-cased keys. */
  headers: Record<string, string>;
  body: Uint8Array;
  /** ISO-8601 UTC timestamp taken when the response arrived. */
  at: string;
};

/** Build a {@link RawResponse} from a fetch `Response`; reads the full body. */
export async function toRawResponse(
  url: string,
  res: Response,
): Promise<RawResponse> {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const body = new Uint8Array(await res.arrayBuffer());
  return {
    url,
    status: res.status,
    headers,
    body,
    at: new Date().toISOString(),
  };
}
