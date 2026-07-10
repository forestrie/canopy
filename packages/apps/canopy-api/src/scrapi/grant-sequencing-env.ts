export interface GrantSequencingResult {
  /** Status URL path: /logs/{bootstrap}/{owner}/entries/{inner}[?subject=T] (caller prepends origin). */
  statusUrlPath: string;
  /** Lowercase hex inner hash (for storage path and status URL). */
  innerHex: string;
  /** Owner log UUID (authority log). */
  ownerLogIdUuid: string;
  /** True if resolveContent(inner) was already non-null (dedupe; did not enqueue). */
  alreadySequenced: boolean;
}

export interface GrantSequencingEnv {
  sequencingQueue: DurableObjectNamespace;
  shardCountStr: string;
}
