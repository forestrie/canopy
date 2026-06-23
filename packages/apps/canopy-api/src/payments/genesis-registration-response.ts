import type { CoordinatorRegistrationStatus } from "../forest/coordinator-registration-status.js";
import type { ForestGenesisChainBinding } from "../forest/genesis-wire.js";
import type { RegistrationClass } from "./registration-class.js";

export interface GenesisRegistrationResponseBody {
  R: string;
  class: RegistrationClass;
  chainBinding: {
    chainId: string;
    univocityAddr: string;
  };
  endorsedBy?: string;
  coordinator?: CoordinatorRegistrationStatus;
}

export function buildGenesisRegistrationResponse(
  r: string,
  registrationClass: RegistrationClass,
  chainBinding: ForestGenesisChainBinding,
  endorsedBy?: string,
  coordinator?: CoordinatorRegistrationStatus,
): GenesisRegistrationResponseBody {
  const body: GenesisRegistrationResponseBody = {
    R: r,
    class: registrationClass,
    chainBinding: {
      chainId: chainBinding.chainId,
      univocityAddr: Array.from(chainBinding.address)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    },
  };
  if (endorsedBy) body.endorsedBy = endorsedBy;
  if (coordinator) body.coordinator = coordinator;
  return body;
}
