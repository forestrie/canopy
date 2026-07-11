/**
 * Ephemeral Imutable bootstrap variants (ES256 + KS256) for system e2e.
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
  mintKs256RootGrantWithWalletKey,
  randomKs256PrivateKeyHex,
  signGrantWithKs256WalletKey,
  signKs256RootStatement,
} from "./ks256-wallet-grant.js";
import {
  COSE_ALG_KS256,
  es256BootstrapContractAddr,
  es256BootstrapContractAddrBytes,
  es256ChainBindingSkipReason,
  fetchOnChainBootstrapConfig,
  ks256BootstrapContractAddr,
  ks256BootstrapContractAddrBytes,
  ks256ChainBindingSkipReason,
  univocityGenesisChainId,
  type OnChainBootstrapConfig,
} from "./univocity-genesis-e2e.js";
import { KS256_UNIVOCITY_MANIFEST_PLACEHOLDER } from "./system-test-manifest-constants.js";

export type BootstrapVariantId = "es256" | "ks256";

export interface E2eBootstrapVariant {
  id: BootstrapVariantId;
  label: string;
  contractAddr: string;
  contractAddrBytes: Uint8Array;
  chainId: string;
  skipReason: () => Promise<string | null>;
  fetchBootstrapKey: () => Promise<OnChainBootstrapConfig>;
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

function buildEs256Variant(): E2eBootstrapVariant {
  const chainId = univocityGenesisChainId();
  const pem = () => {
    const p = bootstrapEs256PrivateKeyPem();
    if (!p) {
      throw new Error(
        "E2E_UNIVOCITY_ES256_BOOTSTRAP_PEM_FILE not set; cannot sign ES256 root grants",
      );
    }
    return p;
  };

  return {
    id: "es256",
    label: "ES256",
    get contractAddr() {
      return es256BootstrapContractAddr();
    },
    get contractAddrBytes() {
      return es256BootstrapContractAddrBytes();
    },
    chainId,
    skipReason: es256ChainBindingSkipReason,
    fetchBootstrapKey: () =>
      fetchOnChainBootstrapConfig(es256BootstrapContractAddr()),
    ensureGenesis: async (request, rootLogId, onboardToken, bootstrapKey) => {
      await ensureForestGenesisEs256E2e(request, {
        logId: rootLogId,
        onboardToken,
        bootstrapKey,
        univocityAddr: es256BootstrapContractAddrBytes(),
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

function buildKs256Variant(): E2eBootstrapVariant {
  const chainId = univocityGenesisChainId();
  const keyHex = () => {
    const k = bootstrapKs256PrivateKeyHex();
    if (!k) {
      throw new Error(
        "E2E_UNIVOCITY_KS256_BOOTSTRAP_KEY_FILE not set; cannot sign KS256 root grants",
      );
    }
    return k;
  };

  return {
    id: "ks256",
    label: "KS256",
    get contractAddr() {
      return ks256BootstrapContractAddr();
    },
    get contractAddrBytes() {
      return ks256BootstrapContractAddrBytes();
    },
    chainId,
    skipReason: ks256ChainBindingSkipReason,
    fetchBootstrapKey: () =>
      fetchOnChainBootstrapConfig(ks256BootstrapContractAddr()),
    ensureGenesis: async (request, rootLogId, onboardToken, bootstrapKey) => {
      await ensureForestGenesisKs256E2e(request, {
        logId: rootLogId,
        onboardToken,
        ks256Address: bootstrapKey,
        univocityAddr: ks256BootstrapContractAddrBytes(),
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

export const E2E_BOOTSTRAP_VARIANTS: readonly E2eBootstrapVariant[] = [
  buildEs256Variant(),
  buildKs256Variant(),
];

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

/** Register a describe block per ephemeral bootstrap variant (ES256 + KS256). */
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
