/**
 * Worker subrequest helper for arbor univocity. Cloudflare Workers calling a
 * proxied hostname in the same zone can receive edge 502; optional
 * UNIVOCITY_RESOLVE_OVERRIDE connects to the GKE ingress IP while preserving
 * the Host header from the service URL.
 */

export function univocityFetch(
  url: string,
  init: RequestInit,
  resolveOverride?: string,
): Promise<Response> {
  const ip = resolveOverride?.trim();
  if (!ip) {
    return fetch(url, init);
  }
  return fetch(url, {
    ...init,
    cf: { resolveOverride: ip },
  });
}
