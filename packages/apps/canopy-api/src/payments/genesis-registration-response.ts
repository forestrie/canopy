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
}

export function buildGenesisRegistrationResponse(
  r: string,
  registrationClass: RegistrationClass,
  chainBinding: ForestGenesisChainBinding,
  endorsedBy?: string,
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
  return body;
}
