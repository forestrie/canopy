/** Options for {@link validateWebhookUrl}. */
export interface ValidateWebhookUrlOptions {
  /** Allow http://localhost and http://127.0.0.1 when true (dev/e2e). */
  allowInsecureLocal?: boolean;
  /** Field name in error messages (default `url`). */
  fieldLabel?: string;
}
