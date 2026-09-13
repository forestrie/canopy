/**
 * @forestrie/scrapi-client — fetch-injectable SCRAPI registration client:
 * POST a grant or signed statement per SCRAPI and interpret the 303
 * receipt-redirect contract with poll-once primitives. NO sleep loops:
 * callers own retry pacing (see the e2e kit's arithmetic backoff ladder).
 *
 * Every network function has a `*Raw` variant returning the raw exchange
 * for EVERY status (no throwing, no interpretation); the parsed functions
 * are built on top of them (plan-2609-07 decision L2).
 *
 * Extracted from @forestrie/canopy-e2e-kit (plan-2607-12 Phase 2, FOR-351).
 */

export {
  COSE_SIGN1_CONTENT_TYPE,
  ScrapiRegistrationError,
  forestrieGrantAuthorization,
  interpretRegisterRedirect,
  registerGrant,
  registerGrantRaw,
  registerSignedStatement,
  registerSignedStatementRaw,
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
  queryRegistrationRaw,
} from "./query-registration.js";
export type {
  QueryRegistrationOnceOptions,
  QueryRegistrationRawOptions,
  RegistrationPollStatus,
} from "./query-registration.js";

export { resolveReceiptOnce, resolveReceiptRaw } from "./resolve-receipt.js";
export type {
  ReceiptResolution,
  ResolveReceiptOnceOptions,
  ResolveReceiptRawOptions,
} from "./resolve-receipt.js";

export {
  PROBLEM_DETAILS_CONTENT_TYPE,
  decodeProblemDetailsBytes,
} from "./problem-details.js";
export type { ProblemDetails } from "./problem-details.js";

export { toAbsoluteScrapiUrl } from "./scrapi-url.js";

export type { RawResponse } from "./raw-response.js";
