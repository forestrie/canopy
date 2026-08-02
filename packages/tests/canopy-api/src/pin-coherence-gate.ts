/**
 * Pin-coherence gate for canopy's system tiers (devdocs plan-2608-03, FOR-516).
 *
 * E2E identity lives in disjoint stores — GitHub Environment vars/secrets,
 * Doppler configs, release manifests, on-chain contracts — and nothing checked
 * that they agreed. On 2026-07-31 they disagreed four separate ways, each
 * surfacing as a 422 ("bootstrapKey/alg does not match") or a 404 deep inside a
 * spec, which reads like a product defect and cost a CI round-trip per layer.
 *
 * The existing guards in `taskfiles/e2e-shared.yml` prove the pins are SET.
 * This proves they AGREE with the chain. Every failure in that chase was a
 * set-but-disagreeing pin, which a presence check passes happily.
 *
 * OWNERSHIP: this surface checks the pins CANOPY can see — the GitHub
 * Environment vars/secrets the tests-system job resolves, against the chain.
 * system-testing's preflight covers manifest ↔ Doppler ↔ chain; the
 * qualification resolver covers manifest-internal consistency (plan-2608-03 Q1).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPinCoherence,
  checkPinCoherence,
  formatPinCoherenceReport,
  type PinContract,
} from "@forestrie/canopy-e2e-kit";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root from packages/tests/canopy-api/src. */
const repoRoot = resolve(__dirname, "../../../..");

/**
 * Strip comments and trailing commas. The contract is JSONC by design — the
 * invariants need explaining where they are declared, not in a separate doc
 * that drifts away from them.
 */
export function parsePinContractJsonc(text: string): PinContract {
  const withoutComments = text
    .replace(
      /("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      (_m, str: string | undefined) => str ?? "",
    )
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutComments) as PinContract;
}

export function loadCanopyPinContract(
  path: string = process.env.CANOPY_PIN_CONTRACT ??
    resolve(repoRoot, "pin-contract.jsonc"),
): PinContract {
  const contract = parsePinContractJsonc(readFileSync(path, "utf8"));
  // An empty pin list would make this gate pass vacuously, which is worse than
  // failing: every pin would look checked-and-fine.
  if (!Array.isArray(contract.pins) || contract.pins.length === 0) {
    throw new Error(
      `${path} declares no pins — refusing to pass vacuously (plan-2608-03 Q2)`,
    );
  }
  return contract;
}

/**
 * Check every declared pin and hard-fail before any spec runs
 * (plan-2608-03 Q3). The thrown report names the pin, both identities, and
 * WHICH STORE holds each side, so the failure points at the thing to fix
 * rather than at whichever spec tripped over it first.
 *
 * Skipped when the suite is not exercising univocity chain-binding at all
 * (`E2E_SKIP_UNIVOCITY_CHAIN_BINDING=true`) — the same switch the presence
 * guards already honour, so this does not change which runs are gated.
 */
export async function runPinCoherenceGate(): Promise<void> {
  if (process.env.E2E_SKIP_UNIVOCITY_CHAIN_BINDING?.trim() === "true") {
    console.log(
      "pin coherence: skipped (E2E_SKIP_UNIVOCITY_CHAIN_BINDING=true)",
    );
    return;
  }
  const report = await checkPinCoherence(loadCanopyPinContract());
  console.log(formatPinCoherenceReport(report));
  assertPinCoherence(report);
}
