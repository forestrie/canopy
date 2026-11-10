/**
 * Ephemeral Imutable bootstrap variants (ES256 + KS256) for system e2e.
 *
 * A variant is bound to one univocity contract and the bootstrap key its
 * `bootstrapConfig()` carries. Canopy's system suite claims a fresh contract
 * per forest from the provisioned pool ({@link claimBootstrapVariant}); lane
 * suites that pin one contract per alg by env use {@link getBootstrapVariant}.
 */

import type { APIRequestContext } from "@playwright/test";
import { createPrivateKey } from "node:crypto";
import { signCoseSign1Statement } from "@forestrie/encoding";
import { test } from "@playwright/test";
import type { Grant } from "@forestrie/grant-builder";
import {
  ensureForestGenesisEs256E2e,
  ensureForestGenesisKs256E2e,
} from "./forest-genesis-e2e.js";
import {
  bootstrapEs256PrivateKeyPem,
  mintEs256RootGrantWithBootstrapPem,
} from "./mint-es256-root-grant-e2e.js";
import {
  signGrantPayloadWithEs256Pem,
  encodeGrantPayloadV0Canonical,
  es256GrantData64FromPrivateKeyPem,
} from "@forestrie/grant-builder";
import {
  bootstrapKs256PrivateKeyHex,
  ks256AddressFromPrivateKeyHex,
  mintKs256RootGrantWithWalletKey,
  randomKs256PrivateKeyHex,
  signGrantWithKs256WalletKey,
  signKs256RootStatement,
} from "./ks256-wallet-grant.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  es256BootstrapContractAddr,
  es256ChainBindingSkipReason,
  fetchOnChainBootstrapConfig,
  ks256BootstrapContractAddr,
  ks256ChainBindingSkipReason,
  univocityChainBindingSkipReason,
  univocityGenesisChainId,
  type OnChainBootstrapConfig,
} from "./univocity-genesis-e2e.js";
import {
  claimUnivocityContract,
  univocityContractPoolSkipReason,
  type UnivocityE2eContract,
} from "./univocity-contract-pool.js";
import { KS256_UNIVOCITY_MANIFEST_PLACEHOLDER } from "./system-test-manifest-constants.js";

export type BootstrapVariantId = "es256" | "ks256";

/** A bootstrap alg bound to one univocity contract and its bootstrap key. */
export interface E2eBootstrapVariant {
  id: BootstrapVariantId;
  label: string;
  contractAddr: string;
  contractAddrBytes: Uint8Array;
  chainId: string;
  skipReason: () => Promise<string | null>;
  fetchBootstrapKey: () => Promise<OnChainBootstrapConfig>;
  /**
   * The private half of the contract's bootstrap key: the PKCS#8 PEM for
   * ES256, the wallet private key hex for KS256.
   * @throws when the key is not configured.
   */
  bootstrapPrivateKey: () => string;
  ensureGenesis: (
    request: APIRequestContext,
    rootLogId: string,
    onboardToken: string,
    bootstrapKey: Uint8Array,
  ) => Promise<void>;
  mintRootGrant: (
    rootLogId: string,
    bootstrapKey: Uint8Array,
  ) => { grantBase64: string };
  signOwnerGrant: (grant: Grant) => string;
  /** COSE Sign1 statement bytes for root log. */
  signRootStatement: (payload: Uint8Array) => Promise<Uint8Array>;
  /** Valid Sign1 with a foreign signer (wrong kid vs grantData). */
  signRootStatementForeignSigner: (payload: Uint8Array) => Promise<Uint8Array>;
  supportsRootStatementRegistration: boolean;
}

/**
 * The fresh contracts for one bootstrap alg. Every forest a spec creates
 * claims its own, because a univocity contract has exactly one root log.
 */
export interface E2eBootstrapVariantPool {
  id: BootstrapVariantId;
  label: string;
  /**
   * Claim an unused contract and return the variant bound to it.
   * @param purpose names the forest; recorded in the claim.
   */
  claim: (purpose: string) => E2eBootstrapVariant;
}

/** Where a variant's contract and bootstrap key come from. */
interface VariantBinding {
  contractAddr: () => string;
  bootstrapPrivateKey: () => string;
  skipReason: () => Promise<string | null>;
  fetchBootstrapKey: () => Promise<OnChainBootstrapConfig>;
}

function bytesToForestrieGrantBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

async function importEs256PemPrivateKey(pem: string): Promise<CryptoKey> {
  const key = createPrivateKey({ key: pem, format: "pem" });
  const pkcs8 = key.export({ format: "der", type: "pkcs8" });
  const buf = new Uint8Array(pkcs8).buffer as ArrayBuffer;
  return crypto.subtle.importKey(
    "pkcs8",
    buf,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

function buildEs256Variant(binding: VariantBinding): E2eBootstrapVariant {
  const chainId = univocityGenesisChainId();
  const pem = binding.bootstrapPrivateKey;

  return {
    id: "es256",
    label: "ES256",
    get contractAddr() {
      return binding.contractAddr();
    },
    get contractAddrBytes() {
      return contractAddrBytes(binding.contractAddr());
    },
    chainId,
    skipReason: binding.skipReason,
    fetchBootstrapKey: binding.fetchBootstrapKey,
    bootstrapPrivateKey: pem,
    ensureGenesis: async (request, rootLogId, onboardToken, bootstrapKey) => {
      await ensureForestGenesisEs256E2e(request, {
        logId: rootLogId,
        onboardToken,
        bootstrapKey,
        univocityAddr: contractAddrBytes(binding.contractAddr()),
        chainId,
      });
    },
    mintRootGrant: (rootLogId, bootstrapKey) =>
      mintEs256RootGrantWithBootstrapPem({
        rootLogId,
        bootstrapKey64: bootstrapKey,
        es256PrivateKeyPem: pem(),
      }),
    signOwnerGrant: (grant) => {
      const payloadBytes = encodeGrantPayloadV0Canonical(grant);
      const sign1 = signGrantPayloadWithEs256Pem(payloadBytes, pem());
      return bytesToForestrieGrantBase64(sign1);
    },
    supportsRootStatementRegistration: true,
    signRootStatement: async (payload) => {
      const p = pem();
      const grantData = es256GrantData64FromPrivateKeyPem(p);
      const kid = grantData.subarray(0, 32);
      const privateKey = await importEs256PemPrivateKey(p);
      return signCoseSign1Statement(payload, kid, privateKey);
    },
    signRootStatementForeignSigner: async (payload) => {
      const pair = (await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const rawSpki = new Uint8Array(
        await crypto.subtle.exportKey("raw", pair.publicKey),
      );
      const wrongKid = rawSpki.subarray(1, 33);
      return signCoseSign1Statement(payload, wrongKid, pair.privateKey);
    },
  };
}

function buildKs256Variant(binding: VariantBinding): E2eBootstrapVariant {
  const chainId = univocityGenesisChainId();
  const keyHex = binding.bootstrapPrivateKey;

  return {
    id: "ks256",
    label: "KS256",
    get contractAddr() {
      return binding.contractAddr();
    },
    get contractAddrBytes() {
      return contractAddrBytes(binding.contractAddr());
    },
    chainId,
    skipReason: binding.skipReason,
    fetchBootstrapKey: binding.fetchBootstrapKey,
    bootstrapPrivateKey: keyHex,
    ensureGenesis: async (request, rootLogId, onboardToken, bootstrapKey) => {
      await ensureForestGenesisKs256E2e(request, {
        logId: rootLogId,
        onboardToken,
        ks256Address: bootstrapKey,
        univocityAddr: contractAddrBytes(binding.contractAddr()),
        chainId,
      });
    },
    mintRootGrant: (rootLogId, bootstrapKey) =>
      mintKs256RootGrantWithWalletKey({
        rootLogId,
        bootstrapAddress20: bootstrapKey,
        ks256PrivateKeyHex: keyHex(),
      }),
    signOwnerGrant: (grant) => signGrantWithKs256WalletKey(grant, keyHex()),
    supportsRootStatementRegistration: true,
    signRootStatement: async (payload) =>
      signKs256RootStatement(payload, keyHex()),
    signRootStatementForeignSigner: async (payload) =>
      signKs256RootStatement(payload, randomKs256PrivateKeyHex()),
  };
}

/**
 * The variants pinned by env (one contract per alg), for lane suites that
 * provision their own contracts. Canopy's system suite claims from the pool
 * instead: see {@link claimBootstrapVariant}.
 */
export const E2E_BOOTSTRAP_VARIANTS: readonly E2eBootstrapVariant[] = [
  buildEs256Variant({
    contractAddr: es256BootstrapContractAddr,
    bootstrapPrivateKey: () =>
      requireKey(
        bootstrapEs256PrivateKeyPem(),
        "E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE not set; cannot sign ES256 root grants",
      ),
    skipReason: es256ChainBindingSkipReason,
    fetchBootstrapKey: () =>
      fetchOnChainBootstrapConfig(es256BootstrapContractAddr()),
  }),
  buildKs256Variant({
    contractAddr: ks256BootstrapContractAddr,
    bootstrapPrivateKey: () =>
      requireKey(
        bootstrapKs256PrivateKeyHex(),
        "E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE not set; cannot sign KS256 root grants",
      ),
    skipReason: ks256ChainBindingSkipReason,
    fetchBootstrapKey: () =>
      fetchOnChainBootstrapConfig(ks256BootstrapContractAddr()),
  }),
];

/**
 * Claim a fresh contract of `id` from the provisioned pool for one forest and
 * return the variant bound to it.
 *
 * @param purpose names the forest; recorded in the claim for diagnosis.
 * @throws when no pool is configured or every `id` contract is claimed.
 */
export function claimBootstrapVariant(
  id: BootstrapVariantId,
  purpose: string,
): E2eBootstrapVariant {
  return bootstrapVariantForContract(claimUnivocityContract(id, purpose));
}

/**
 * The variant bound to `contract`. Its {@link E2eBootstrapVariant.fetchBootstrapKey}
 * refuses a contract whose on-chain bootstrap key is not the public half of
 * `contract.bootstrapPrivateKey`, so a mispaired pool fails at the forest that
 * uses it rather than as a genesis 422.
 */
export function bootstrapVariantForContract(
  contract: UnivocityE2eContract,
): E2eBootstrapVariant {
  const binding: VariantBinding = {
    contractAddr: () => contract.address,
    bootstrapPrivateKey: () => contract.bootstrapPrivateKey,
    skipReason: () =>
      univocityChainBindingSkipReason(
        contract.address,
        contract.alg === "es256" ? COSE_ALG_ES256 : COSE_ALG_KS256,
      ),
    fetchBootstrapKey: () => fetchPooledBootstrapKey(contract),
  };
  return contract.alg === "es256"
    ? buildEs256Variant(binding)
    : buildKs256Variant(binding);
}

async function fetchPooledBootstrapKey(
  contract: UnivocityE2eContract,
): Promise<OnChainBootstrapConfig> {
  const onChain = await fetchOnChainBootstrapConfig(contract.address);
  const expected =
    contract.alg === "es256"
      ? es256GrantData64FromPrivateKeyPem(contract.bootstrapPrivateKey)
      : ks256AddressFromPrivateKeyHex(contract.bootstrapPrivateKey);
  if (!bytesEqual(onChain.key, expected)) {
    throw new Error(
      `bootstrapConfig() of pooled ${contract.alg} contract ${contract.address} ` +
        "does not match the private key the pool pairs with it",
    );
  }
  return onChain;
}

function requireKey(key: string | undefined, missing: string): string {
  if (!key) throw new Error(missing);
  return key;
}

function contractAddrBytes(addr: string): Uint8Array {
  const hex = addr.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`univocity contract address must be 20 bytes: ${addr}`);
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function getBootstrapVariant(
  id: BootstrapVariantId,
): E2eBootstrapVariant {
  const v = E2E_BOOTSTRAP_VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`unknown bootstrap variant: ${id}`);
  return v;
}

/**
 * Pick ES256 vs KS256 for bootstrap-grant and GF_DERIVED system e2e.
 *
 * Prefers the manifest ks256 pin when it is a live EOA-backed contract; otherwise
 * reads `bootstrapConfig()` at the es256 pin (mandate-register slot).
 */
export async function bootstrapVariantForGrantE2e(): Promise<E2eBootstrapVariant> {
  const ks256Addr = process.env.E2E_UNIVOCITY_ADDRESS_KS256_BOOTSTRAP?.trim();
  if (
    ks256Addr &&
    ks256Addr.toLowerCase() !==
      KS256_UNIVOCITY_MANIFEST_PLACEHOLDER.toLowerCase()
  ) {
    const ks256Skip = await ks256ChainBindingSkipReason();
    if (!ks256Skip) {
      return getBootstrapVariant("ks256");
    }
  }

  let boot: OnChainBootstrapConfig;
  try {
    boot = await fetchOnChainBootstrapConfig(es256BootstrapContractAddr());
  } catch {
    return getBootstrapVariant("es256");
  }
  if (boot.alg === COSE_ALG_KS256 && boot.key.length === 20) {
    return getBootstrapVariant("ks256");
  }
  return getBootstrapVariant("es256");
}

/**
 * Register a describe block per env-pinned bootstrap variant (ES256 +
 * KS256), for lane suites that pin one contract per alg. A contract has one
 * root log, so only the first forest rooted on each pin ever anchors; canopy's
 * suite uses {@link describeForEachBootstrapPool} instead.
 */
export function describeForEachBootstrapVariant(
  title: string,
  register: (variant: E2eBootstrapVariant) => void,
): void {
  for (const variant of E2E_BOOTSTRAP_VARIANTS) {
    test.describe(`${title} (${variant.label})`, () => {
      test.beforeAll(async () => {
        const skip = await variant.skipReason();
        if (skip) test.skip(true, skip);
      });
      register(variant);
    });
  }
}

/**
 * Register a describe block per bootstrap alg (ES256 + KS256). `register`
 * receives that alg's contract pool; each forest the block creates claims its
 * own contract from it. The block skips when the pool has none of the alg.
 */
export function describeForEachBootstrapPool(
  title: string,
  register: (pool: E2eBootstrapVariantPool) => void,
): void {
  for (const { id, label } of E2E_BOOTSTRAP_VARIANTS) {
    const describeTitle = `${title} (${label})`;
    test.describe(describeTitle, () => {
      test.beforeAll(() => {
        const skip = univocityContractPoolSkipReason(id);
        if (skip) test.skip(true, skip);
      });
      register({
        id,
        label,
        claim: (purpose) =>
          claimBootstrapVariant(id, `${describeTitle}: ${purpose}`),
      });
    });
  }
}
