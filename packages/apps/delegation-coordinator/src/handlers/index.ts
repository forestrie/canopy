/**
 * HTTP route handler re-exports for delegation-coordinator index router.
 */

export { handleIssueDelegation } from "./issue-delegation.js";
export { handleGetPendingDelegation } from "./get-pending-delegation.js";
export { handleGetSigningRoute } from "./get-signing-route.js";
export { handlePostSigningRoute } from "./post-signing-route.js";
export { handlePostCertificate } from "./post-certificate.js";
export { handlePostDelegateKeys } from "./post-delegate-keys.js";
export { handleGetPending } from "./get-pending.js";
export {
  handlePostCustodyKeys,
  handleAdminPostCustodyKeys,
} from "./post-custody-keys.js";
export { handleGetPublicRoot } from "./get-public-root.js";
export { handlePostPublicRoot } from "./post-public-root.js";
export { handleAdminResetStorage } from "./admin-reset-storage.js";
export { handleGetWebhook } from "./get-webhook.js";
export { handlePutWebhook } from "./put-webhook.js";
export { handleDeleteWebhook } from "./delete-webhook.js";
export { handleGetEnabled } from "./get-enabled.js";
export { handlePutEnabled } from "./put-enabled.js";
export { handleAdminGetEnabled } from "./admin-get-enabled.js";
export { handleAdminPutEnabled } from "./admin-put-enabled.js";
export { handleGetWebhookJwks, WEBHOOK_JWKS_PATH } from "./get-webhook-jwks.js";
export { handlePostAuthChallenge } from "./post-auth-challenge.js";
export { handlePostAuthSession } from "./post-auth-session.js";
