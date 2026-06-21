/**
 * Verify GF_DERIVED endorsement transparent statement against the endorser forest
 * bootstrap authority key (ARC-0019 §4: envelope signer for leaves under O).
 */

import { COSE_ALG_ES256, COSE_ALG_KS256 } from "../cose/cose-key.js";
import type { ParsedForestGenesis } from "../forest/genesis-cache.js";
import { verifyKs256CoseSign1 } from "../grant/ks256-verify.js";
import type { GrantResult } from "../grant/types.js";
import { verifyGrantCoseSign1WithGrantDataXy } from "./custodian-grant.js";

export async function verifyDerivedEndorsementEnvelope(
  grantResult: GrantResult,
  genesis: ParsedForestGenesis,
): Promise<boolean> {
  const bytes = grantResult.bytes;
  if (!bytes?.length) return false;

  if (genesis.bootstrapAlg != null && genesis.bootstrapKey) {
    if (
      genesis.bootstrapAlg === COSE_ALG_ES256 &&
      genesis.bootstrapKey.length === 64
    ) {
      return verifyGrantCoseSign1WithGrantDataXy(bytes, genesis.bootstrapKey);
    }
    if (
      genesis.bootstrapAlg === COSE_ALG_KS256 &&
      genesis.bootstrapKey.length === 20
    ) {
      return verifyKs256CoseSign1(bytes, { address: genesis.bootstrapKey });
    }
    return false;
  }

  if (genesis.x && genesis.y) {
    const xy = new Uint8Array(64);
    xy.set(genesis.x, 0);
    xy.set(genesis.y, 32);
    return verifyGrantCoseSign1WithGrantDataXy(bytes, xy);
  }

  return false;
}
