#!/usr/bin/env node
/**
 * Naming-hygiene gate (devdocs plan-2607-43, D6).
 *
 * The identifier previously called `instanceKey` / `liableAccountKey` /
 * `accountKey` has exactly one name: `univocityInstanceId`
 * (SQL `univocity_instance_id`). This gate fails the build when a banned
 * name appears outside the explicit allowlist, so retired vocabulary cannot
 * creep back in. The ban list grows per plan-2607-43 slice; the allowlist is
 * for migrations, wire-compatibility shims, and their tests only — each entry
 * carries the slice that removes it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BANNED = [
  // Slice 01 seeded instanceKey; slice 02 retired the payment graph (and the
  // liable-account vocabulary); slice 03 re-keyed the receivables store, so
  // the account-key spelling is dead too. One identifier, one name.
  /instanceKey/,
  /instance_key/,
  /liableAccount/,
  /accountKey/,
  /account_key/,
  // Slice 05 closes the list (plan-2607-43 D6): the pre-ADR-0059 registration
  // taxonomy is retired everywhere outside tolerant readers of legacy R2
  // records. \b keeps LegacyRegistrationClass (the tolerated spelling) legal
  // in its one allowlisted home without matching new uses of the bare name.
  /payment-authoritative/i,
  /\bRegistrationClass/,
  /endorsedBy/,
];

/**
 * path-prefix → reason. FROZEN as of slice 05 (plan-2607-43 D6): every entry
 * is either the gate itself, a migration over legacy stored state, a tolerant
 * reader of legacy stored records, or a test pinning one of those. Adding an
 * entry requires the same justification discipline — new product code never
 * qualifies.
 */
const ALLOWLIST = {
  "scripts/check-naming.mjs": "the gate itself",
  "packages/apps/delegation-coordinator/src/durableobjects/delegation-store.ts":
    "legacy column/value migration over deployed shard state; retires with the migration",
  "packages/apps/delegation-coordinator/src/legacy-instance-id.ts":
    "legacy-form conversion used only by the delegation-store migration",
  "packages/apps/x402-settlement/src/durableobjects/receivables.ts":
    "legacy column rename migration (pre-v3 local state); retires with the migration",
  "packages/apps/canopy-api/src/payments/registration-record.ts":
    "tolerant reader: legacy registration.json objects carry class values (no data rewrite); retire with a record backfill",
  "packages/apps/canopy-api/src/payments/registration-store.ts":
    "tolerant reader for legacy registration.json fields; retire with a record backfill",
  "packages/apps/canopy-api/test/payments-registration.test.ts":
    "pins the tolerant reader against a legacy record fixture",
  "packages/apps/delegation-coordinator/test/unit/univocity-instance-id-migration.test.ts":
    "seeds legacy instance_key state to pin the migration",
  "packages/apps/delegation-coordinator/test/unit/webhook-legacy-instance-binding.test.ts":
    "pins slice-05 strictness: retired field ignored, legacy forms rejected",
  "packages/apps/delegation-coordinator/test/unit/instance-webhook.test.ts":
    "pins retired-alias absence in responses and rejection in requests",
  "packages/apps/delegation-coordinator/test/unit/webhook.test.ts":
    "pins retired-alias rejection on the log-webhook route",
};

const files = execFileSync("git", ["ls-files", "--", "packages", "scripts"], {
  encoding: "utf8",
})
  .split("\n")
  .filter((f) => /\.(ts|mts|cts|js|mjs|cjs|jsonc?|sql|toml|yaml|yml)$/.test(f));

const hits = [];
for (const file of files) {
  if (Object.keys(ALLOWLIST).some((prefix) => file.startsWith(prefix))) {
    continue;
  }
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (const banned of BANNED) {
    lines.forEach((line, i) => {
      if (banned.test(line)) {
        hits.push(
          `${file}:${i + 1}: banned name ${banned.source}: ${line.trim()}`,
        );
      }
    });
  }
}

if (hits.length > 0) {
  console.error(
    "naming-hygiene gate (plan-2607-43 D6): retired identifier names found.\n" +
      "Use univocityInstanceId / univocity_instance_id, or add a justified\n" +
      "allowlist entry in scripts/check-naming.mjs.\n",
  );
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`naming-hygiene gate: clean (${files.length} files scanned)`);
