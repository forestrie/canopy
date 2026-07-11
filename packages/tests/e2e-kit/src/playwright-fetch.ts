/**
 * Adapt a Playwright APIRequestContext to the fetch signature expected by
 * @forestrie/scrapi-client, so kit poll loops stay thin wrappers over the
 * package's poll-once primitives while tests keep Playwright's HTTP stack
 * (baseURL, tracing, proxies).
 *
 * Redirects are never followed (`maxRedirects: 0`) — the SCRAPI client always
 * interprets 3xx itself (`redirect: "manual"` semantics).
 */

import type { APIRequestContext } from "@playwright/test";

export function playwrightFetch(request: APIRequestContext): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers as HeadersInit).forEach((value, key) => {
        headers[key] = value;
      });
    }

    let data: Buffer | undefined;
    const body = init?.body;
    if (body != null) {
      if (typeof body === "string") data = Buffer.from(body);
      else if (body instanceof Uint8Array) data = Buffer.from(body);
      else if (body instanceof ArrayBuffer)
        data = Buffer.from(new Uint8Array(body));
      else throw new Error("playwrightFetch: unsupported request body type");
    }

    const res = await request.fetch(url, {
      method: init?.method ?? "GET",
      headers,
      data,
      maxRedirects: 0,
    });

    const status = res.status();
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(res.headers())) {
      responseHeaders.set(key, value);
    }
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : new Uint8Array(await res.body()), {
      status,
      statusText: res.statusText(),
      headers: responseHeaders,
    });
  }) as typeof fetch;
}
