import type { CanopyOpsAdminEnv } from "./canopy-ops-admin-env.js";
import type { CanopyReceiptVerifierEnv } from "./canopy-receipt-verifier-env.js";
import type { CanopySequencingEnv } from "./canopy-sequencing-env.js";

/** Env slice required for {@link checkRequestEnv} (structural typing with worker `Env`). */
export type CanopyCheckRequestEnv = CanopyOpsAdminEnv &
  CanopySequencingEnv &
  CanopyReceiptVerifierEnv;
