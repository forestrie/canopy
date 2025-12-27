/**
 * Environment bindings for ranger-cache worker.
 */
import type { SequencedContent } from "./durableobjects/index.js";

/**
 * R2 object body interface (subset of R2ObjectBody we need).
 */
export interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * R2 bucket interface (subset of R2Bucket we need).
 */
export interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
}

/**
 * Environment bindings available to the ranger-cache worker.
 */
export interface Env {
  /** Environment name */
  NODE_ENV: string;
  /** Canopy instance identifier */
  CANOPY_ID: string;
  /** Durable Object namespace for sequenced content per log */
  SEQUENCED_CONTENT: DurableObjectNamespace<SequencedContent>;
  /** R2 bucket containing massif blobs */
  R2_MMRS: R2Bucket;
}
