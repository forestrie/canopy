#!/usr/bin/env node
/**
 * R2_GRANTS write-discipline tripwire (canopy plan-2607-03 R4).
 *
 * Cloudflare has no read-only R2 bindings, so x402-settlement's `R2_GRANTS`
 * binding is structurally write-capable over the registration bucket even
 * though the worker must only ever read it. This guard fails the build when
 * any member access on `R2_GRANTS` other than `.list(` / `.get(` (or a bare
 * truthiness/presence check) appears in x402-settlement source — a cheap
 * tripwire against drift until the capability itself is removed (dedicated
 * reservation-index bucket or ops-authed enumeration; slice-05 / build-vs-buy
 * revisit).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "packages/apps/x402-settlement/src");

/** Member accesses on the binding that constitute a read. */
const ALLOWED_MEMBERS = new Set(["list", "get"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // Every `R2_GRANTS.<member>` in a line; passing the binding itself
    // (e.g. `listRegisteredAccounts(env.R2_GRANTS)`) is fine — the callee
    // lives in this package and is scanned too.
    for (const m of line.matchAll(/R2_GRANTS\s*[.?]+\s*(\w+)/g)) {
      if (!ALLOWED_MEMBERS.has(m[1])) {
        violations.push(
          `${relative(ROOT, file)}:${i + 1}: R2_GRANTS.${m[1]} — only .list()/.get() are permitted (plan-2607-03 R4)`,
        );
      }
    }
    // The indexer receives the binding as a `bucket` parameter — hold that
    // identifier to the same read-only surface within src/indexer/.
    if (file.includes(`${join("src", "indexer")}`)) {
      for (const m of line.matchAll(/\bbucket\s*[.?]+\s*(\w+)/g)) {
        if (!ALLOWED_MEMBERS.has(m[1])) {
          violations.push(
            `${relative(ROOT, file)}:${i + 1}: bucket.${m[1]} — only .list()/.get() are permitted (plan-2607-03 R4)`,
          );
        }
      }
    }
  });
}

if (violations.length > 0) {
  console.error("R2_GRANTS write-discipline check FAILED:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("R2_GRANTS discipline ok (x402-settlement reads only)");
