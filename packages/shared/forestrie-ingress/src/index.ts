/**
 * @canopy/forestrie-ingress — shared SequencingQueue contract types.
 *
 * Consumed by `@canopy/forestrie-ingress` (HTTP pull/ack for arbor **ranger**)
 * and `@canopy/api` (Durable Object owner). Wire shapes must stay aligned with
 * [arbor ingress ARC](https://github.com/forestrie/arbor/blob/main/docs/arc-cloudflare-do-ingress.md).
 */

// Re-export all types from types.ts (which aggregates from individual files)
export type {
  PullRequest,
  PullResponse,
  LogGroup,
  Entry,
  AckRequest,
  AckResponse,
  SequencingResult,
  QueueStats,
  EnqueueExtras,
  SequencingQueueStub,
} from "./types.js";

export type { ProblemDetails } from "./problemdetails.js";
export { PROBLEM_TYPES, PROBLEM_CONTENT_TYPE } from "./problemdetails.js";
export { QueueFullError } from "./errors.js";
