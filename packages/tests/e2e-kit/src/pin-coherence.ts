/**
 * Pin-coherence checking (devdocs plan-2608-03, FOR-516).
 *
 * E2E identity lives in several disjoint stores — GitHub environment
 * vars/secrets, Doppler configs, release manifests, on-chain contracts —
 * and nothing checked that they agreed. When they disagreed, the symptom
 * was a 422 ("genesis bootstrapKey/alg does not match the univocity
 * instance bootstrapConfig()") or a 404 deep inside a spec, which reads
 * like a product defect and costs a CI round-trip per layer to unpeel.
 * The 2026-07-31 qualification chase burned five such round-trips.
 *
 * A suite declares its pins in `pin-contract.jsonc`; this checks every
 * declared invariant BEFORE any spec runs and reports violations naming
 * the pin, both identities, and WHICH STORE holds each side.
 */

import { es256GrantData64FromPrivateKeyPem } from "@forestrie/grant-builder";
import { ks256AddressFromPrivateKeyHex } from "@forestrie/grant-builder";
import { readFileSync } from "node:fs";
import {
  COSE_ALG_ES256,
  COSE_ALG_KS256,
  fetchOnChainBootstrapConfig,
  univocityRpcUrlForE2e,
} from "./univocity-genesis-e2e.js";

/** How a pin's key half is carried. */
export type PinKeyKind =
  /** Env var holding a 0x-prefixed 20-byte address. */
  | "eth-address"
  /** Env var holding a 0x-prefixed secp256k1 private key. */
  | "secp256k1-private-hex"
  /** Env var holding a PATH to a P-256 private key PEM. */
  | "p256-pem-file";

export type PinInvariant = "instanceHasCode" | "keyMatchesInstance";

export interface PinDeclaration {
  id: string;
  description?: string;
  /** Env var holding the univocity instance address. */
  instanceVar: string;
  /** Env var holding the key half — an address (`keyVar`) or material (`keySecret`). */
  keyVar?: string;
  keySecret?: string;
  keyKind: PinKeyKind;
  alg: "ks256" | "es256";
  chainVar: string;
  invariants: PinInvariant[];
  /**
   * Values of `instanceVar` that mean "this lane does not configure this pin",
   * treated exactly as if the var were unset.
   *
   * Some tiers substitute a documented sentinel rather than leaving the var
   * empty — `e2e-univocity-ci-resolve-pins.sh` fills an unconfigured KS256 pin
   * with `KS256_UNIVOCITY_MANIFEST_PLACEHOLDER`. Without this the sentinel
   * reads as a real instance, the pin looks half-configured, and the check
   * fails on a lane that is correctly signalling "not configured". That
   * happened: it blocked canopy v0.1.8.
   *
   * DECLARED, not inferred: the checker never guesses which addresses are
   * placeholders, because a guess that is wrong in the other direction would
   * silently skip a real pin.
   */
  absentWhen?: string[];
}

export interface PinContract {
  schemaVersion: number;
  suite: string;
  pins: PinDeclaration[];
}

export interface PinViolation {
  pin: string;
  invariant: string;
  detail: string;
  expected?: string;
  actual?: string;
  /** Which store holds each side — the actionable part. */
  stores: { instance: string; key: string };
}

export interface PinCoherenceReport {
  suite: string;
  checked: string[];
  skipped: Array<{ pin: string; reason: string }>;
  violations: PinViolation[];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function addressToBytesHex(address: string): string {
  return address.trim().replace(/^0x/i, "").toLowerCase();
}

function keySourceVar(pin: PinDeclaration): string | undefined {
  return pin.keyVar ?? pin.keySecret;
}

/**
 * The key half's identity as it should appear on chain, or null when the
 * source is absent. ks256 → 20-byte address; es256 → 64-byte x‖y.
 */
function expectedKeyHex(
  pin: PinDeclaration,
  env: NodeJS.ProcessEnv,
): string | null {
  const source = keySourceVar(pin);
  if (!source) return null;
  const raw = env[source]?.trim();
  if (!raw) return null;
  switch (pin.keyKind) {
    case "eth-address":
      return addressToBytesHex(raw);
    case "secp256k1-private-hex":
      // Returns the 20 address bytes, which is exactly what a ks256
      // bootstrapConfig() carries.
      return bytesToHex(
        ks256AddressFromPrivateKeyHex(raw.startsWith("0x") ? raw : `0x${raw}`),
      );
    case "p256-pem-file":
      return bytesToHex(
        es256GrantData64FromPrivateKeyPem(readFileSync(raw, "utf8")),
      );
  }
}

function expectedAlg(pin: PinDeclaration): number {
  return pin.alg === "ks256" ? COSE_ALG_KS256 : COSE_ALG_ES256;
}

/**
 * Check every declared pin. A pin whose BOTH halves are absent is skipped
 * (that tier simply does not use it); a pin with one half present is a
 * violation, because half-configured identity is the state that produces
 * the misleading deep failures this check exists to prevent.
 */
export async function checkPinCoherence(
  contract: PinContract,
  opts: { rpcUrl?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<PinCoherenceReport> {
  const env = opts.env ?? process.env;
  const report: PinCoherenceReport = {
    suite: contract.suite,
    checked: [],
    skipped: [],
    violations: [],
  };

  for (const pin of contract.pins) {
    const rawInstance = env[pin.instanceVar]?.trim();
    const source = keySourceVar(pin);
    const keyPresent = Boolean(source && env[source]?.trim());

    // A declared sentinel means "this lane does not configure this pin" and is
    // treated as unset. Reported as its own skip reason rather than folded into
    // the both-unset case, so a lane sitting on a placeholder is visible in the
    // report instead of looking like it was never wired at all.
    const isSentinel = Boolean(
      rawInstance &&
        pin.absentWhen?.some(
          (v) => v.toLowerCase() === rawInstance.toLowerCase(),
        ),
    );
    const instance = isSentinel ? undefined : rawInstance;

    if (isSentinel && !keyPresent) {
      report.skipped.push({
        pin: pin.id,
        reason: `${pin.instanceVar} is the declared not-configured placeholder ${rawInstance}`,
      });
      continue;
    }

    if (!instance && !keyPresent) {
      report.skipped.push({
        pin: pin.id,
        reason: `${pin.instanceVar} and ${source ?? "<no key var>"} both unset`,
      });
      continue;
    }
    if (!instance || !keyPresent) {
      report.violations.push({
        pin: pin.id,
        invariant: "pairPresent",
        detail:
          "half-configured pin: one side is set and the other is not, so " +
          "specs will bind to a mismatched identity",
        expected: `both ${pin.instanceVar} and ${source ?? "<key var>"} set`,
        actual: instance ? `only ${pin.instanceVar}` : `only ${source}`,
        stores: { instance: pin.instanceVar, key: source ?? "<key var>" },
      });
      continue;
    }

    report.checked.push(pin.id);
    const stores = { instance: pin.instanceVar, key: source! };
    const rpcUrl = opts.rpcUrl ?? univocityRpcUrlForE2e();

    let chain: { alg: number; key: Uint8Array };
    try {
      chain = await fetchOnChainBootstrapConfig(instance, rpcUrl);
    } catch (error) {
      report.violations.push({
        pin: pin.id,
        invariant: pin.invariants.includes("instanceHasCode")
          ? "instanceHasCode"
          : "keyMatchesInstance",
        detail:
          `could not read bootstrapConfig() at ${instance}: ` +
          (error instanceof Error ? error.message : String(error)),
        stores,
      });
      continue;
    }

    if (pin.invariants.includes("keyMatchesInstance")) {
      const expected = expectedKeyHex(pin, env);
      const actual = bytesToHex(chain.key);
      if (chain.alg !== expectedAlg(pin)) {
        report.violations.push({
          pin: pin.id,
          invariant: "keyMatchesInstance",
          detail: `instance is bootstrapped for a different algorithm`,
          expected: `alg ${expectedAlg(pin)} (${pin.alg})`,
          actual: `alg ${chain.alg}`,
          stores,
        });
      } else if (expected && expected !== actual) {
        report.violations.push({
          pin: pin.id,
          invariant: "keyMatchesInstance",
          detail:
            "the key this suite holds is not the key the pinned instance " +
            "is bootstrapped to — genesis against it will 422",
          expected: `0x${expected} (from ${source})`,
          actual: `0x${actual} (on-chain at ${instance})`,
          stores,
        });
      }
    }
  }

  return report;
}

/** Human-readable report; the violation lines name the store to fix. */
export function formatPinCoherenceReport(report: PinCoherenceReport): string {
  const lines: string[] = [
    `pin coherence (${report.suite}): ${report.checked.length} checked, ` +
      `${report.skipped.length} skipped, ${report.violations.length} violations`,
  ];
  for (const s of report.skipped) {
    lines.push(`  - skip ${s.pin}: ${s.reason}`);
  }
  for (const v of report.violations) {
    lines.push(`  ✗ ${v.pin} [${v.invariant}]: ${v.detail}`);
    if (v.expected) lines.push(`      expected: ${v.expected}`);
    if (v.actual) lines.push(`      actual:   ${v.actual}`);
    lines.push(
      `      stores:   instance=${v.stores.instance} key=${v.stores.key}`,
    );
  }
  return lines.join("\n");
}

/** Throw with the formatted report when anything is incoherent. */
export function assertPinCoherence(report: PinCoherenceReport): void {
  if (report.violations.length === 0) return;
  throw new Error(formatPinCoherenceReport(report));
}
