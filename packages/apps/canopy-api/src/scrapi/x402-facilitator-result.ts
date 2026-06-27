/**
 * CDP API credentials for JWT authentication.
 */
export interface CdpCredentials {
  keyId: string;
  keySecret: string;
}

export type VerifyResult =
  | {
      ok: true;
      /** Identifier for this payment authorization */
      authId: string;
      /** Whether the payment is valid */
      isValid: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export type SettleResult =
  | {
      ok: true;
      /** Transaction hash from settlement */
      transaction: string;
      /** Network the settlement occurred on */
      network: string;
    }
  | {
      ok: false;
      error: string;
      /** Whether this is a permanent error (should not retry) */
      permanent?: boolean;
    };
