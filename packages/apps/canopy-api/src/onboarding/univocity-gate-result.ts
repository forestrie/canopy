export type UnivocityGateResult =
  | {
      ok: true;
      univocityAddr: string;
      /** Chain-declared bootstrapConfig() — the attestation trust anchor (slice 06). */
      bootstrapAlg: number;
      bootstrapKey: Uint8Array;
    }
  | { ok: false; status: number; detail: string };
