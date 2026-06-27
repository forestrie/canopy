/** Env slice for mandatory sequencing queue outside Vitest pool workers. */
export interface CanopySequencingEnv {
  NODE_ENV: string;
  SEQUENCING_QUEUE?: unknown;
}
