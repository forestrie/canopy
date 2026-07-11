/** T2 minimum slice (coordinator env + onboard token) */
export {
  delegationCoordinatorBaseUrl,
  coordinatorAppToken,
  hasCoordinatorApiE2eEnv,
  assertCoordinatorApiE2eEnv,
} from "./coordinator-api-env.js";
export {
  E2E_POLL_MAX_WAIT_MS,
  E2E_SYSTEM_TEST_TIMEOUT_MS,
  sequencingBackoff,
  sleepMs,
  pollQueryRegistrationUntilReceiptRedirect,
  pollResolveReceiptUntil200,
  type PollUntilReceiptOptions,
  type PollUntilReceiptResult,
  type PollReceiptBodyOptions,
} from "./arithmetic-backoff-poll.js";
export {
  assertOpsAdminE2eEnv,
  mintOnboardTokenE2e,
} from "./onboard-token-e2e.js";
export { playwrightFetch } from "./playwright-fetch.js";

/** SCRAPI registration primitives — re-exported from @forestrie/scrapi-client
 * (plan-2607-12 Phase 2, FOR-351); the kit poll loops above are thin ladders
 * over these. */
export {
  COSE_SIGN1_CONTENT_TYPE,
  RECEIPT_LOCATION_RE,
  ScrapiRegistrationError,
  decodeProblemDetailsBytes,
  forestrieGrantAuthorization,
  interpretRegisterRedirect,
  parseEntryIdFromReceiptLocation,
  queryRegistrationOnce,
  registerGrant,
  registerSignedStatement,
  resolveReceiptOnce,
  toAbsoluteScrapiUrl,
} from "@forestrie/scrapi-client";
export type {
  ProblemDetails,
  QueryRegistrationOnceOptions,
  ReceiptResolution,
  RegisterGrantOptions,
  RegisterRedirect,
  RegisterResponseView,
  RegisterSignedStatementOptions,
  RegistrationPollStatus,
  ResolveReceiptOnceOptions,
} from "@forestrie/scrapi-client";

export * from "./e2e-testing-tier.js";

/** T2 bootstrap + T3 genesis slice (0.2.0) */
export { attachReceiptAndIdtimestampToTransparentStatement } from "./attach-transparent-statement-receipt.js";
export { genesisBodyEs256 } from "./genesis-body-es256.js";
export * from "./univocity-genesis-e2e.js";
export * from "./e2e-env-guards.js";
export * from "./e2e-grant-flags.js";
export * from "./forest-genesis-e2e.js";
export {
  encodeGrantPayloadV0Canonical,
  es256GrantData64FromPrivateKeyPem,
  signGrantPayloadWithEs256Pem,
} from "@forestrie/grant-builder";
export * from "./mint-es256-root-grant-e2e.js";
export * from "./ks256-wallet-grant.js";
export * from "./e2e-bootstrap-variant.js";
export * from "./mint-root-grant-e2e.js";
export * from "./bootstrap-grant-flow.js";
export * from "./bootstrap-grant-setup.js";
export * from "./register-grant-through-receipt.js";
export * from "./bootstrap-delegation-coordinator.js";
export * from "./coordinator-delegation-helpers.js";
export * from "./wallet-challenge-session-e2e.js";
export * from "./delegation-cbor-contract.js";
export * from "./byok-wallet-seal-helpers.js";
export * from "./entry-id-e2e.js";
export * from "./forestrie-hex-id.js";
export * from "./statement-sign-bytes.js";
export * from "./cbor-int-key.js";

/** T3 Mode C slice (0.3.0) */
export * from "./mode-c-e2e-env.js";
export * from "./mode-c-webhook-ingress.js";
export * from "./mode-c-webhook-seal-helpers.js";
export * from "./mode-c-webhook-tunnel.js";
export * from "./mode-c-webhook-receiver.js";
export * from "./post-entries-e2e.js";
export * from "./custodian-custody-grant.js";
export * from "./custodian-api-env.js";
export * from "./custodian-api-sign.js";
export * from "./custodian-api-public-key.js";
export * from "./custodian-api-ops.js";
export * from "./custodian-api-keys-list.js";
export * from "./custodian-api-ensure-key.js";
export * from "./custodian-api-delete-key.js";
export * from "./custodian-api-curator-log-key.js";
export * from "./custodian-api-cbor.js";
export * from "./custodian-sign-payload.js";
export * from "./e2e-custodian-labels.js";
export * from "./e2e-static-log-ids.js";
export * from "./forestrie-operator-labels.js";

/** Wire types (re-exported from @forestrie/grant-builder for cross-repo consumers) */
export type { Grant } from "@forestrie/grant-builder";
export {
  uuidToBytes,
  bytesToUuid,
  toPaddedWire32,
} from "@forestrie/grant-builder";
export { KS256_UNIVOCITY_MANIFEST_PLACEHOLDER } from "./system-test-manifest-constants.js";
export {
  HEADER_RECEIPT,
  HEADER_IDTIMESTAMP,
  HEADER_FORESTRIE_GRANT_V0,
} from "@forestrie/grant-builder";

/** Encoding helpers (re-exported from @forestrie/encoding) */
export {
  decodeCoseSign1,
  encodeSigStructure,
  mergeUnprotectedIntoCoseSign1,
  signCoseSign1Statement,
} from "@forestrie/encoding";

/** Offline receipt verify slice (0.4.0) — re-exported from @forestrie/receipt-verify (plan-0030, FOR-286) */
export {
  verifyGrantReceiptOffline,
  parseReceipt,
  decodeTrustRootFromGenesis,
  type VerifyGrantReceiptOfflineInput,
  type ReceiptVerifyResult,
  type ReceiptVerifyStage,
} from "@forestrie/receipt-verify";
