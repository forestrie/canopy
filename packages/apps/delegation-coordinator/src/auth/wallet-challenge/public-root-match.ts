import { decode } from "cbor-x";
import type { Env } from "../../env.js";
import { getStoreStubForLogId } from "../../handlers/handler.js";
import { COSE_ALG_KS256 } from "../../types/trust-root-response.js";
import type { TrustRootResponseCbor } from "../../types/trust-root-response.js";

export type PublicRootMaterial =
  | { alg: "ES256"; x: Uint8Array; y: Uint8Array }
  | { alg: "KS256"; key: Uint8Array };

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

  const decoded = decode(
    new Uint8Array(await resp.arrayBuffer()),
  ) as TrustRootResponseCbor;
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
