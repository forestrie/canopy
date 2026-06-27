import type { CanopyBootstrapTrioEnv } from "./canopy-bootstrap-trio-env.js";
import type { CanopyOpsAdminEnv } from "./canopy-ops-admin-env.js";
import type { CanopyReceiptVerifierEnv } from "./canopy-receipt-verifier-env.js";
import type { CanopySequencingEnv } from "./canopy-sequencing-env.js";

/** Env slice required for {@link checkRequestEnv} (structural typing with worker `Env`). */
export type CanopyCheckRequestEnv = CanopyOpsAdminEnv &
  CanopyBootstrapTrioEnv &
  CanopySequencingEnv &
  CanopyReceiptVerifierEnv;
