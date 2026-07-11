/** Resolve a redirect Location against the SCRAPI base URL. */
export function toAbsoluteScrapiUrl(baseUrl: string, location: string): string {
  if (location.startsWith("http")) return location;
  const base = baseUrl.replace(/\/$/, "");
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}
