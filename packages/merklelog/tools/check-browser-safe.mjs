/**
 * Browser-safety guard (ADR-0048, plan-2607-18 W2/M2): bundle the package
 * entry for the browser platform and fail if any node builtin is in the
 * module graph. This proves @forestrie/merklelog's public surface — including
 * the FOR-373 urkle content-hash reader (`src/massifs/leafindex.ts`) — has no
 * edge to node-only code, so `@forestrie/receipt-verify` (whose own guard
 * bundles its entry) can depend on it and remain browser-safe.
 *
 * receipt-verify's guard scans only its own module graph, and leafindex.ts is
 * not imported by receipt-verify, so it would not be covered there. This guard
 * covers it directly and additionally asserts leafindex.ts is present in the
 * bundled graph, so the check can never silently stop covering it.
 *
 * esbuild with `platform: "browser"` already errors on unresolvable `node:*`
 * specifiers; the metafile scan below also catches bare builtin names
 * (e.g. "crypto") that a future config change might externalize.
 */
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

// leafindex.ts must be reachable from the entry and in the bundled graph —
// this is the FOR-373 reader the guard exists to cover (plan-2607-18 W2/M2).
const requiredInputs = ["src/massifs/leafindex.ts"];

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

let result;
try {
  result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
} catch (err) {
  console.error(
    "browser-safety check FAILED: @forestrie/merklelog does not bundle for the browser platform.",
  );
  for (const e of err.errors ?? []) {
    console.error(
      `  ${e.text}${e.location ? ` (${e.location.file}:${e.location.line})` : ""}`,
    );
  }
  process.exit(1);
}

const inputs = Object.keys(result.metafile.inputs);

// A builtin can only appear in the metafile as an external import edge
// (an unresolvable one already failed the build above).
const offenders = [];
for (const [input, meta] of Object.entries(result.metafile.inputs)) {
  for (const imp of meta.imports ?? []) {
    if (builtins.has(imp.path)) {
      offenders.push(`${input} -> ${imp.path}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(
    "browser-safety check FAILED: node builtins in @forestrie/merklelog's module graph:",
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

// Guard against the check silently ceasing to cover the FOR-373 reader
// (e.g. if it were dropped from the entry's export surface).
const missing = requiredInputs.filter(
  (req) => !inputs.some((input) => input.endsWith(req)),
);
if (missing.length > 0) {
  console.error(
    "browser-safety check FAILED: expected file(s) not in @forestrie/merklelog's bundled graph:",
  );
  for (const m of missing) console.error(`  ${m}`);
  console.error(
    "  (this guard must cover the FOR-373 urkle content-hash reader — see plan-2607-18 W2/M2)",
  );
  process.exit(1);
}

console.log(
  "browser-safety check passed: @forestrie/merklelog bundles for platform=browser with no node builtins (covers src/massifs/leafindex.ts, FOR-373).",
);
