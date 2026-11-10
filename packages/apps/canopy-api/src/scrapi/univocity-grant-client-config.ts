/** Configuration for reaching the univocity grants endpoint. */
export interface UnivocityGrantClient {
  /** Base service URL, e.g. `https://univocity.example`. */
  serviceUrl: string;
  /** Bearer token authorizing canopy -> univocity calls. */
  token: string;
}

/**
 * univocity's answer to a claim (`POST /api/grants`):
 *
 * - `accepted`: claimed. `created` is false for a re-post of the same grant.
 *   `state` is `reserved` (with the lapse time `expiresAt`, unix seconds) or
 *   `committed`.
 * - `conflict`: 409; `title` is univocity's problem title, e.g.
 *   `grant-already-claimed` for a different grant on a claimed log.
 * - `rejected`: another 4xx (invalid grant or grant chain).
 * - `unavailable`: 5xx, unreachable, or an answer that could not be read.
 */
export type UnivocityGrantResult =
  | {
      kind: "accepted";
      created: boolean;
      state: string;
      expiresAt?: number;
    }
  | { kind: "conflict"; title: string; detail: string }
  | { kind: "rejected"; status: number; detail: string }
  | { kind: "unavailable"; detail: string };

/**
 * Seam for creation-grant validation. register-grant depends only on this
 * interface, so unit tests can inject a mock and exercise the whole flow without
 * HTTP or local crypto. The production implementation forwards to univocity.
 */
export interface CreationGrantValidator {
  /**
   * Commits the create grant's claim (intent `commit`): from here on it never
   * lapses, so the caller must sequence the grant.
   *
   * @param rootLogId 16-byte forest root `R` (bootstrap log id).
   * @param statementBytes raw transparent statement (COSE Sign1) credential.
   */
  validate(
    rootLogId: Uint8Array,
    statementBytes: Uint8Array,
  ): Promise<UnivocityGrantResult>;
}
