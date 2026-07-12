/**
 * Load stored public roots and match wallet signers (ES256 / KS256).
 *
 * Upstream: {@link DelegationStoreDO} public_roots table.
 * Downstream: POST /api/auth/session verifies signer equals registered root
 * per [univocity KS256 / ES256 models](https://github.com/forestrie/univocity/blob/main/docs/arc/).
 */

import { decodeCborStruct } from "../../cbor.js";
import type { Env } from "../../env.js";
import { getStoreStubForLogId } from "../../handlers/handler.js";
import { COSE_ALG_KS256 } from "../../types/trust-root-response.js";
import type { TrustRootResponseCbor } from "../../types/trust-root-response.js";

/** Parsed public root material for signer comparison. */
export type PublicRootMaterial =
  | { alg: "ES256"; x: Uint8Array; y: Uint8Array }
  | { alg: "KS256"; key: Uint8Array };

/**
 * Load registered public root for an authority log from the sharded store.
 *
 * @param env - Worker bindings.
 * @param authLogIdHex32 - Normalized authority log id.
 * @returns Parsed root material or null when not uploaded.
 */
export async function loadRegisteredPublicRoot(
  env: Env,
  authLogIdHex32: string,
): Promise<PublicRootMaterial | null> {
  const stub = getStoreStubForLogId(env, authLogIdHex32);
  const resp = await stub.fetch(
    `https://coordinator.internal/public-root/${authLogIdHex32}`,
    { method: "GET", headers: { Accept: "application/cbor" } },
  );
  if (resp.status === 404) return null;
  if (!resp.ok) return null;

  const decoded = decodeCborStruct<TrustRootResponseCbor>(
    new Uint8Array(await resp.arrayBuffer()),
  );
  if (decoded.alg === "ES256" && decoded.x && decoded.y) {
    return { alg: "ES256", x: decoded.x, y: decoded.y };
  }
  const algInt =
    typeof decoded.alg === "number" ? decoded.alg : Number(decoded.alg);
  if (algInt === COSE_ALG_KS256 && decoded.key) {
    return { alg: "KS256", key: decoded.key };
  }
  return null;
}

/**
 * True when recovered KS256 address equals stored 20-byte root key.
 *
 * @param recoveredAddress - Address from personal_sign recovery.
 * @param rootKey - Stored KS256 root bytes from public_roots.
 */
export function ks256AddressMatchesRoot(
  recoveredAddress: `0x${string}`,
  rootKey: Uint8Array,
): boolean {
  if (rootKey.length !== 20) return false;
  const addr = recoveredAddress.toLowerCase();
  const expected = [...rootKey]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return addr === `0x${expected}`;
}

/** Constant-time byte equality for public key coordinates. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True when ES256 signer coordinates match stored root x/y.
 *
 * @param signerX - Signer P-256 x (32 bytes).
 * @param signerY - Signer P-256 y (32 bytes).
 * @param rootX - Stored root x.
 * @param rootY - Stored root y.
 */
export function es256PublicKeyMatchesRoot(
  signerX: Uint8Array,
  signerY: Uint8Array,
  rootX: Uint8Array,
  rootY: Uint8Array,
): boolean {
  if (signerX.length !== 32 || signerY.length !== 32) return false;
  if (rootX.length !== 32 || rootY.length !== 32) return false;
  return bytesEqual(signerX, rootX) && bytesEqual(signerY, rootY);
}
