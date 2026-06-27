/** Validation failure for {@link validateWebhookUrl} (caller maps to 4xx). */
export class WebhookUrlValidationError extends Error {
  /**
   * @param message - Human-readable validation failure
   */
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlValidationError";
  }
}
