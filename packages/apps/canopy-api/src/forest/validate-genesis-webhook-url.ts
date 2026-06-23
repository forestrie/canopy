/**
 * Syntactic webhook URL validation for genesis ?webhookUrl= (matches coordinator rules).
 */

import {
  WebhookUrlValidationError,
  validateWebhookUrl,
} from "@canopy/webhook-url";

export class GenesisWebhookUrlValidationError extends WebhookUrlValidationError {
  constructor(message: string) {
    super(message);
    this.name = "GenesisWebhookUrlValidationError";
  }
}

export interface ValidateGenesisWebhookUrlOptions {
  /** Allow http://localhost and http://127.0.0.1 when true (dev/e2e). */
  allowInsecureLocal?: boolean;
}

export function validateGenesisWebhookUrl(
  raw: string,
  options?: ValidateGenesisWebhookUrlOptions,
): string {
  try {
    return validateWebhookUrl(raw, {
      allowInsecureLocal: options?.allowInsecureLocal,
      fieldLabel: "webhookUrl",
    });
  } catch (error) {
    if (error instanceof WebhookUrlValidationError) {
      throw new GenesisWebhookUrlValidationError(error.message);
    }
    throw error;
  }
}
