/**
 * @forestrie/scrapi-client — fetch-injectable SCRAPI registration client:
 * POST a grant or signed statement per SCRAPI and interpret the 303
 * receipt-redirect contract with poll-once primitives. NO sleep loops:
 * callers own retry pacing (see the e2e kit's arithmetic backoff ladder).
 *
 * Extracted from @forestrie/canopy-e2e-kit (plan-2607-12 Phase 2, FOR-351).
 */

export {
  COSE_SIGN1_CONTENT_TYPE,
  ScrapiRegistrationError,
  forestrieGrantAuthorization,
  interpretRegisterRedirect,
  registerGrant,
  registerSignedStatement,
} from "./register.js";
export type {
  RegisterGrantOptions,
  RegisterRedirect,
  RegisterResponseView,
  RegisterSignedStatementOptions,
} from "./register.js";

export {
  RECEIPT_LOCATION_RE,
  parseEntryIdFromReceiptLocation,
  queryRegistrationOnce,
} from "./query-registration.js";
export type {
  QueryRegistrationOnceOptions,
  RegistrationPollStatus,
} from "./query-registration.js";

export { resolveReceiptOnce } from "./resolve-receipt.js";
export type {
  ReceiptResolution,
  ResolveReceiptOnceOptions,
} from "./resolve-receipt.js";

export { decodeProblemDetailsBytes } from "./problem-details.js";
export type { ProblemDetails } from "./problem-details.js";

export { toAbsoluteScrapiUrl } from "./scrapi-url.js";
