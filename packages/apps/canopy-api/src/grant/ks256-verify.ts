/**
 * KS256 COSE Sign1 verification: Keccak-256 Sig_structure + ecrecover / ERC-1271.
 * Matches univocity `verifyKS256Raw` / `verifyDelegationProofKS256`. EOA
 * recovery, with its low-s bound, is delegation-cose's
 * {@link recoverKs256Signer}, so canopy has one copy of it.
 */

import { keccak_256 } from "@noble/hashes/sha3";
import { recoverKs256Signer } from "@forestrie/delegation-cose";
import {
  COSE_ALG_KS256,
  decodeCoseSign1,
  encodeSigStructure,
} from "@forestrie/encoding";
import {
  createErc1271VerifyHooks,
  Erc1271UnavailableError,
} from "@forestrie/chain-rpc";
import type { ParsedKs256RootKey } from "./parsed-ks256-root-key.js";

export interface Ks256VerifyOptions {
  /** Preference-ordered JSON-RPC URLs for ERC-1271 `eth_call` and `eth_getCode`. */
  rpcUrls?: string[];
  logFailures?: boolean;
  logPrefix?: string;
  /**
   * Rethrow {@link Erc1271UnavailableError} (after logging) instead of
   * collapsing it to `false`, so the boundary can answer 503 instead of a
   * verification verdict (plan-2607-09 R1). Default false: every existing
   * chain (delegation-verify, receipt resolution, child-log prepare) keeps
   * logged fail-closed `false`.
   */
  throwOnUnavailable?: boolean;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Verify a COSE Sign1 with KS256 (Keccak Sig_structure + 65-byte eth sig).
 * An EOA root's signature must be low-s; a contract root's goes to ERC-1271
 * unchanged.
 */
export async function verifyKs256CoseSign1(
  coseSign1Bytes: Uint8Array,
  root: ParsedKs256RootKey,
  opts?: Ks256VerifyOptions,
): Promise<boolean> {
  const decoded = decodeCoseSign1(coseSign1Bytes);
  if (!decoded) {
    if (opts?.logFailures) {
      console.warn(
        JSON.stringify({
          tag: "verifyKs256Failure",
          prefix: opts.logPrefix ?? "",
          reason: "decode_failed",
        }),
      );
    }
    return false;
  }

  const sigStructure = encodeSigStructure(
    decoded.protectedBstr,
    new Uint8Array(0),
    decoded.payloadBstr,
  );
  const hash = keccak_256(sigStructure);
  const signature = decoded.signature;

  const rpcUrls = opts?.rpcUrls?.filter((u) => u.trim().length > 0) ?? [];
  if (rpcUrls.length > 0) {
    const hooks = createErc1271VerifyHooks(rpcUrls);
    try {
      if (await hooks.hasContractCode(root.address)) {
        return await hooks.isValidSignature(root.address, hash, signature);
      }
    } catch (e) {
      if (opts?.logFailures) {
        console.warn(
          JSON.stringify({
            tag: "verifyKs256Failure",
            prefix: opts.logPrefix ?? "",
            reason: "erc1271_rpc_failed",
            error: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      if (opts?.throwOnUnavailable && e instanceof Erc1271UnavailableError) {
        throw e;
      }
      return false;
    }
  }

  if (signature.length !== 65) {
    if (opts?.logFailures) {
      console.warn(
        JSON.stringify({
          tag: "verifyKs256Failure",
          prefix: opts.logPrefix ?? "",
          reason: "signature_wrong_length",
          signatureLen: signature.length,
        }),
      );
    }
    return false;
  }

  const recovered = recoverKs256Signer(hash, signature);
  const ok = recovered.ok && bytesEqual(recovered.address, root.address);
  if (!ok && opts?.logFailures) {
    console.warn(
      JSON.stringify({
        tag: "verifyKs256Failure",
        prefix: opts.logPrefix ?? "",
        reason:
          !recovered.ok && recovered.reason === "signature_high_s"
            ? "signature_high_s"
            : "ecrecover_mismatch",
      }),
    );
  }
  return ok;
}

/** Verify a delegation certificate COSE Sign1 signed by a KS256 root address. */
export async function verifyKs256DelegationCert(
  delegationCertBytes: Uint8Array,
  root: ParsedKs256RootKey,
  opts?: Ks256VerifyOptions,
): Promise<boolean> {
  return verifyKs256CoseSign1(delegationCertBytes, root, {
    ...opts,
    logPrefix: opts?.logPrefix ?? "delegation-cert-ks256",
  });
}

export { COSE_ALG_KS256 };
