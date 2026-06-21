/** SHA-256 hex digest of the presented onboard token (lowercase). */
export async function hashOnboardToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function onboardTokenR2Key(hash: string): string {
  return `payments/onboard-tokens/${hash}.json`;
}
