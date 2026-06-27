/** Env slice for receipt COSE verification readiness (Custodian app token). */
export interface CanopyReceiptVerifierEnv {
  NODE_ENV: string;
  CUSTODIAN_APP_TOKEN?: string;
  DELEGATION_COORDINATOR_URL?: string;
  COORDINATOR_APP_TOKEN?: string;
  /** Test-only; must not be set outside pool mode (footgun guard). */
  FORESTRIE_RECEIPT_VERIFY_TEST_ES256_XY_HEX?: string;
}
