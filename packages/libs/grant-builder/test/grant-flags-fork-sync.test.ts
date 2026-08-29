/**
 * Fork sync-guard for the duplicated `grant-flags.ts` (review Q2, plan-2608-09).
 *
 * `grant-flags.ts` exists in two copies that MUST agree on flag semantics:
 *   - this package (`@forestrie/grant-builder`, the source of truth), and
 *   - the canopy-api fork (`apps/canopy-api/src/grant/grant-flags.ts`), which the
 *     worker imports without depending on grant-builder.
 *
 * The fork is a deliberate *subset*: canopy-api omits the data-log constructor
 * helpers it never uses. This guard reads both files as text and asserts that
 * every function the fork DOES carry is byte-identical to its grant-builder
 * counterpart, and that the only divergence is the known, allow-listed set of
 * grant-builder-only helpers. A silent drift in any shared predicate (e.g. a bit
 * mask edited in one copy) fails here; adding a new grant-builder-only export
 * fails until it is consciously added to the allow-list. Runs in the node
 * environment (grant-builder's vitest config), so `node:fs` is available.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const BUILDER_COPY = resolve(here, "../src/grant-flags.ts");
const CANOPY_COPY = resolve(
  here,
  "../../../apps/canopy-api/src/grant/grant-flags.ts",
);

/** Exports present only in grant-builder — the intentional, reviewed divergence. */
const BUILDER_ONLY = new Set([
  "dataLogCreateExtendFlags",
  "dataLogExtendFlags",
  // Byte-2 alg-band opt-in (plan-2608-13). canopy-api now READS the flag at
  // admission (`hasRequiresUserVerification` is mirrored into the fork —
  // devdocs ADR-0065 §4, plan-2608-14) but still never issues UV-flagged
  // grants, so the setter stays grant-builder-only.
  "withRequiresUserVerification",
]);

/** Map each `export function NAME` to its full source block (name → closing brace). */
function exportedFunctions(source: string): Map<string, string> {
  const normalized = source.replace(/\r\n/g, "\n");
  const re = /^export function (\w+)[\s\S]*?^}/gm;
  const out = new Map<string, string>();
  for (const m of normalized.matchAll(re)) {
    out.set(m[1]!, m[0]!.trimEnd());
  }
  return out;
}

describe("grant-flags fork sync-guard", () => {
  const builder = exportedFunctions(readFileSync(BUILDER_COPY, "utf8"));
  const canopy = exportedFunctions(readFileSync(CANOPY_COPY, "utf8"));

  it("parsed a non-trivial set of exports from both copies", () => {
    expect(builder.size).toBeGreaterThan(5);
    expect(canopy.size).toBeGreaterThan(5);
  });

  it("every function the canopy-api fork carries is byte-identical in grant-builder", () => {
    for (const [name, canopySrc] of canopy) {
      expect(builder.has(name), `grant-builder is missing ${name}`).toBe(true);
      expect(
        builder.get(name),
        `${name} has drifted between the two copies`,
      ).toBe(canopySrc);
    }
  });

  it("the only grant-builder-only exports are the allow-listed helpers", () => {
    const builderOnly = [...builder.keys()]
      .filter((n) => !canopy.has(n))
      .sort();
    expect(builderOnly).toEqual([...BUILDER_ONLY].sort());
  });
});
