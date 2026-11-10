/** Env slice for receipt COSE verification readiness (univocity log authority). */
export interface CanopyReceiptVerifierEnv {
  NODE_ENV: string;
  /** univocity base URL: the only source of log root keys. */
  UNIVOCITY_SERVICE_URL?: string;
  /** Test-only; must not be set outside pool mode (footgun guard). */
  FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX?: string;
}
