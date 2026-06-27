import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";

/** Env for receipt-based authorization (inclusion verification). */
export interface AuthGrantAuthorizeEnv {
  /**
   * When true, the grant must pass receipt-based inclusion verification.
   * Set by callers whenever sequencing/inclusion is configured; false only in
   * pool-test mode with incomplete bindings (auth skipped). This is a
   * configuration flag, not Durable Object queue state.
   */
  enforceInclusion: boolean;
  /**
   * Resolves receipt signature verify key candidates (trust root + delegation).
   * Required when `enforceInclusion` is true.
   */
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
  /** Forest chain binding chainId for KS256 ERC-1271 RPC routing. */
  ks256ChainId?: string;
}
