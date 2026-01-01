import type { SequencingQueue } from "./durableobjects/sequencingqueue.js";

/**
 * Environment bindings for the forestrie-ingress worker.
 */
export interface Env {
  /** Durable Object namespace for the sequencing queue */
  SEQUENCING_QUEUE: DurableObjectNamespace<SequencingQueue>;
  /** Canopy instance identifier */
  CANOPY_ID: string;
  /** Environment: dev or prod */
  NODE_ENV: string;
  /** Number of DO shards for the sequencing queue (typically 4) */
  QUEUE_SHARD_COUNT: string;
}
