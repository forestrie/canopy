/**
 * Types for the server-side x402-settlement receivables read (FOR-497).
 */

export interface SettlementReceivablesClientEnv {
  /** Base URL of the x402-settlement worker (e.g. its workers.dev origin). */
  X402_SETTLEMENT_URL?: string;
  /** The shared operator identity x402-settlement's `/admin/**` gate checks. */
  CANOPY_OPS_ADMIN_TOKEN?: string;
}

/**
 * The owner-relevant slice of x402-settlement's `/admin/receivables/{id}`
 * response. `registrationBlock` is `null` when the genesis-time observation
 * failed (ops repair pending) and absent on legacy records.
 */
export interface SettlementReceivablesRead {
  creditsBalance: number;
  checkpointsAccrued: number;
  arrears: string;
  enforcementFrozen: boolean;
  registrationBlock?: number | null;
  watermarkBlock: number | null;
}

export type SettlementReceivablesResult =
  | { ok: true; read: SettlementReceivablesRead }
  | { ok: false; status: number; detail: string };
