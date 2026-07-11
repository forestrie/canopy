/**
 * Mint the **root creation grant** for an ES256 chain-bound forest, signed by
 * the contract's on-chain bootstrap key.
 *
 * Unlike the legacy per-log Custodian mint, the root grant's `grantData` and
 * signer are the contract's ES256 bootstrap key, so `grantData ==
 * bootstrapConfig()` and arbor's root-grant check passes against the real
 * on-chain anchor (`verifyGrantChainDepth`, [grant_chain.go]). The grant is
 * self-owned (`logId == ownerLogId == R`) with the auth-log bootstrap flag
 * shape.
 */

import type { Grant } from "./grant.js";
import { uuidToBytes } from "./uuid-bytes.js";
import { authLogBootstrapShapedFlags } from "./grant-flags.js";
import { encodeGrantPayloadV0Canonical } from "./grant-payload-canonical.js";
import {
  es256GrantData64FromPrivateKeyPem,
  signGrantPayloadWithEs256Pem,
} from "./es256-pem-grant.js";
import { bytesToForestrieGrantBase64 } from "./grant-base64.js";

const ES256_GRANT_DATA_BYTES = 64;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Build + sign the ES256 root creation grant for `rootLogId` with the on-chain
 * bootstrap key PEM. Asserts the PEM public key equals the on-chain bootstrap key
 * (so `grantData == bootstrapConfig()` and the envelope verifies against it).
 *
 * @param rootLogId - the forest root R (UUID).
 * @param bootstrapKey64 - on-chain `bootstrapConfig().key` (ES256 x‖y, 64 bytes).
 * @param es256PrivateKeyPem - ephemeral ES256 bootstrap PEM from provision.
 */
export function mintEs256RootGrantWithBootstrapPem(opts: {
  rootLogId: string;
  bootstrapKey64: Uint8Array;
  es256PrivateKeyPem: string;
}): { grantBase64: string; grantData: Uint8Array } {
  if (opts.bootstrapKey64.length !== ES256_GRANT_DATA_BYTES) {
    throw new Error(
      `ES256 bootstrap key must be ${ES256_GRANT_DATA_BYTES} bytes (x‖y); got ${opts.bootstrapKey64.length}`,
    );
  }
  const pemKey = es256GrantData64FromPrivateKeyPem(opts.es256PrivateKeyPem);
  if (!bytesEqual(pemKey, opts.bootstrapKey64)) {
    throw new Error(
      "ES256 bootstrap PEM public key does not match the on-chain bootstrapConfig() " +
        "key; the root grant signer must be the contract's bootstrap key.",
    );
  }

  const id16 = uuidToBytes(opts.rootLogId);
  const grant: Grant = {
    logId: id16,
    ownerLogId: id16,
    grant: authLogBootstrapShapedFlags(),
    maxHeight: 0,
    minGrowth: 0,
    grantData: opts.bootstrapKey64,
  };

  const payloadBytes = encodeGrantPayloadV0Canonical(grant);
  const sign1 = signGrantPayloadWithEs256Pem(
    payloadBytes,
    opts.es256PrivateKeyPem,
  );
  return {
    grantBase64: bytesToForestrieGrantBase64(sign1),
    grantData: opts.bootstrapKey64,
  };
}
