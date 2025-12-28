/**
 * Environment bindings for the forestrie-ingress worker.
 */
export interface Env {
  /** Durable Object namespace for the sequencing queue */
  SEQUENCING_QUEUE: DurableObjectNamespace;
  /** Canopy instance identifier */
  CANOPY_ID: string;
  /** Environment: dev or prod */
  NODE_ENV: string;
}
