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
  // Slice 01. Slices 03/04 add: accountKey, account_key, liableAccount.
  /instanceKey/,
  /instance_key/,
];

/** path-prefix → reason. Entries removed by the slice named in the reason. */
const ALLOWLIST = {
  "scripts/check-naming.mjs": "the gate itself",
  "packages/apps/canopy-api/src/forest/forward-coordinator-registration.ts":
    "dual-field wire shim, drops in slice 05",
  "packages/apps/canopy-api/test/forest-genesis-coordinator-forward.test.ts":
    "asserts the dual-field shim, drops in slice 05",
  "packages/apps/delegation-coordinator/src/durableobjects/delegation-store.ts":
    "legacy column/value migration, drops when the migration retires",
  "packages/apps/delegation-coordinator/src/legacy-instance-id.ts":
    "legacy-form conversion, drops when migration and shim retire",
  "packages/apps/delegation-coordinator/src/handlers/put-webhook.ts":
    "deprecated request-field shim, drops in slice 05",
  "packages/apps/delegation-coordinator/src/handlers/instance-webhook.ts":
    "legacy response-field alias, drops in slice 05",
  "packages/apps/delegation-coordinator/src/types/":
    "deprecated wire-field declarations, drop in slice 05",
  "packages/apps/delegation-coordinator/test/":
    "migration + shim coverage, tightens in slice 05",
  "docs/": "historical docs; aligned in slice 05",
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
        hits.push(`${file}:${i + 1}: banned name ${banned.source}: ${line.trim()}`);
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
