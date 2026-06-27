/**
 * Convenience re-exports for delegation-coordinator domain types.
 *
 * Prefer importing from single-responsibility modules directly; this barrel
 * exists for consumers needing several shapes at once.
 */

export type { DelegationCertificateRecord } from "./delegation-certificate-record.js";
export type { SubmitDelegationCertificateRequest } from "./submit-delegation-certificate-request.js";
/** @deprecated use DelegationCertificateRecord */
export type { MaterialRecord } from "./material-record.js";
/** @deprecated use SubmitDelegationCertificateRequest */
export type { SubmitMaterialRequest } from "./submit-material-request.js";
