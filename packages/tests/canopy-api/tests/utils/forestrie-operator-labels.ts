/** GCP KMS keys use `fo-` (colon in docs maps to hyphen); user keys must not use this prefix. */
export const FORESTRIE_OPERATOR_LABEL_PREFIX = "fo-";

export function assertUserLabelKeysNotOperatorPrefix(
  labels?: Record<string, string>,
): void {
  if (!labels) return;
  for (const k of Object.keys(labels)) {
    if (k.trim().toLowerCase().startsWith(FORESTRIE_OPERATOR_LABEL_PREFIX)) {
      throw new Error("user label key uses reserved Forestrie operator prefix");
    }
  }
}
