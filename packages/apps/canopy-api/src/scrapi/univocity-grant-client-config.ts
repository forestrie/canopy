/** Configuration for reaching the univocity grants endpoint. */
export interface UnivocityGrantClient {
  /** Base service URL, e.g. `https://univocity.example`. */
  serviceUrl: string;
  /** Bearer token authorizing canopy -> univocity calls. */
  token: string;
}

export type UnivocityGrantResult =
  | { kind: "accepted"; created: boolean }
  | { kind: "conflict"; detail: string }
  | { kind: "rejected"; status: number; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * Seam for creation-grant validation. register-grant depends only on this
 * interface, so unit tests can inject a mock and exercise the whole flow without
 * HTTP or local crypto. The production implementation forwards to univocity.
 */
export interface CreationGrantValidator {
  /**
   * @param rootLogId 16-byte forest root `R` (bootstrap log id).
   * @param statementBytes raw transparent statement (COSE Sign1) credential.
   */
  validate(
    rootLogId: Uint8Array,
    statementBytes: Uint8Array,
  ): Promise<UnivocityGrantResult>;
}
