/**
 * Matches Custodian `NormalizeForestrieHexID32`: trim, 0x strip, hyphens removed, 32 lowercase hex.
 */
export function normalizeForestrieHexId32(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s.startsWith("0x")) s = s.slice(2);
  s = s.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(s)) {
    throw new Error("forestrie id must be 32 lowercase hex digits");
  }
  return s;
}
