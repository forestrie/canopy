/** Thrown when a webhook URL fails syntactic validation. */
export class WebhookUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlValidationError";
  }
}
