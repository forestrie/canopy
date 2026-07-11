/**
 * Browser-safety guard (ADR-0048, plan-2607-13 W4/C8): bundle the package
 * entry for the browser platform and fail if any node builtin is in the
 * module graph. This is the proof that receipt-verify has no edge to
 * node-only code (the layering inversion found as C8), and the same check
 * FOR-363's ES256 PEM rewrite reuses.
 *
 * esbuild with `platform: "browser"` already errors on unresolvable
 * `node:*` specifiers; the metafile scan below also catches bare builtin
 * names (e.g. "crypto") that a future config change might externalize.
 */
import { build } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

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
    "browser-safety check FAILED: @forestrie/receipt-verify does not bundle for the browser platform.",
  );
  for (const e of err.errors ?? []) {
    console.error(
      `  ${e.text}${e.location ? ` (${e.location.file}:${e.location.line})` : ""}`,
    );
  }
  process.exit(1);
}

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
    "browser-safety check FAILED: node builtins in @forestrie/receipt-verify's module graph:",
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log(
  "browser-safety check passed: @forestrie/receipt-verify bundles for platform=browser with no node builtins.",
);
