import type { CoordinatorRegistrationStatus } from "../forest/coordinator-registration-status.js";
import type { ForestGenesisChainBinding } from "../forest/genesis-wire.js";

/**
 * Class and endorsedBy are gone (ADR-0059, slice 02): every instance root is
 * its own account, so the registration response carries only the account
 * identity.
 */
export interface GenesisRegistrationResponseBody {
  R: string;
  chainBinding: {
    chainId: string;
    univocityAddr: string;
  };
  coordinator?: CoordinatorRegistrationStatus;
}

export function buildGenesisRegistrationResponse(
  r: string,
  chainBinding: ForestGenesisChainBinding,
  coordinator?: CoordinatorRegistrationStatus,
): GenesisRegistrationResponseBody {
  const body: GenesisRegistrationResponseBody = {
    R: r,
    chainBinding: {
      chainId: chainBinding.chainId,
      univocityAddr: Array.from(chainBinding.address)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    },
  };
  if (coordinator) body.coordinator = coordinator;
  return body;
}
