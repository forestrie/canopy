/**
 * Inject per-project forestrie-ingress Worker name and host-scoped route (ARC-0001).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) {
    args.set(key, "true");
  } else {
    args.set(key, value);
    i += 1;
  }
}

const envName = args.get("env") ?? process.env.DEPLOY_ENV ?? "prod";
const inputPath = resolve(args.get("input") ?? "wrangler.jsonc");
const outputPath = resolve(args.get("out") ?? ".wrangler.runtime.jsonc");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (c === "\\") i += 1;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === "/" && n === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === openChar) depth += 1;
    if (c === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function blockForProperty(
  text,
  property,
  openChar,
  closeChar,
  start = 0,
  end = text.length,
) {
  const prop = `"${property}"`;
  const idx = text.indexOf(prop, start);
  if (idx < 0 || idx > end) return null;
  const open = text.indexOf(openChar, idx + prop.length);
  if (open < 0 || open > end) return null;
  const close = findMatching(text, open, openChar, closeChar);
  if (close < 0 || close > end) return null;
  return { start: open, end: close, text: text.slice(open, close + 1) };
}

function replaceRange(text, range, replacement) {
  return text.slice(0, range.start) + replacement + text.slice(range.end + 1);
}

function setStringProperty(block, key, value) {
  if (!value) return block;
  const re = new RegExp(`("${key}"\\s*:\\s*)"[^"]*"`);
  if (re.test(block)) return block.replace(re, `$1"${value}"`);
  const insert = `\n        "${key}": "${value}",`;
  return block.replace(/\n\s*}$/, `${insert}\n      }`);
}

function zoneFromFqdn(fqdn) {
  const parts = fqdn.split(".").filter(Boolean);
  if (parts.length < 2) return fqdn;
  return parts.slice(-2).join(".");
}

function hostnameFromFqdnOrUrl(value) {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname;
    } catch {
      fail(`Invalid URL for hostname extraction: ${trimmed}`);
    }
  }
  return trimmed.replace(/^https?:\/\//, "").split("/")[0];
}

function envWorkerNamePattern() {
  return /(\{\s*(?:\/\/[^\n]*\n\s*)*"name"\s*:\s*)"[^"]*"/;
}

function insertAfterEnvName(envBlock, insertText) {
  const re = /(\{\s*(?:\/\/[^\n]*\n\s*)?"name"\s*:\s*"[^"]*",)/;
  if (!re.test(envBlock)) fail("Could not find env name for injection.");
  return envBlock.replace(re, `$1${insertText}`);
}

function setRoutes(envBlock, fqdn) {
  if (!fqdn) return envBlock;
  const zone = zoneFromFqdn(fqdn);
  const routesBody = `[
        {
          "pattern": "${fqdn}/canopy/ingress-queue/*",
          "zone_name": "${zone}",
        },
      ]`;
  const existing = blockForProperty(envBlock, "routes", "[", "]");
  if (existing) {
    return replaceRange(envBlock, existing, routesBody);
  }
  const insert = `\n      "routes": ${routesBody},`;
  return insertAfterEnvName(envBlock, insert);
}

function setWorkerName(envBlock, scriptName) {
  if (!scriptName) return envBlock;
  const re = envWorkerNamePattern();
  if (!re.test(envBlock))
    fail("Could not find env worker name for script rename.");
  return envBlock.replace(re, `$1"${scriptName}"`);
}

let config = readFileSync(inputPath, "utf8");
const envs = blockForProperty(config, "env", "{", "}");
if (!envs) fail("Could not find top-level env block in wrangler config.");
const target = blockForProperty(
  config,
  envName,
  "{",
  "}",
  envs.start,
  envs.end,
);
if (!target) fail(`Could not find env.${envName} block in wrangler config.`);

let envBlock = target.text;

const scriptName = process.env.SEQUENCING_QUEUE_SCRIPT_NAME?.trim();
if (!scriptName) {
  fail(
    "SEQUENCING_QUEUE_SCRIPT_NAME is required for forestrie-ingress deploy.",
  );
}
envBlock = setWorkerName(envBlock, scriptName);

const vars = blockForProperty(envBlock, "vars", "{", "}");
if (vars) {
  let varsBlock = vars.text;
  varsBlock = setStringProperty(
    varsBlock,
    "FOREST_PROJECT_ID",
    process.env.FOREST_PROJECT_ID,
  );
  envBlock = replaceRange(envBlock, vars, varsBlock);
}

const edgeFqdn = hostnameFromFqdnOrUrl(process.env.CANOPY_FQDN);
if (!edgeFqdn) {
  fail("CANOPY_FQDN is required for forestrie-ingress deploy runtime config.");
}
envBlock = setRoutes(envBlock, edgeFqdn);

config = replaceRange(config, target, envBlock);
writeFileSync(outputPath, config);
console.log(
  `Wrote ${outputPath} for env ${envName} (${scriptName} route on ${edgeFqdn}/canopy/ingress-queue/*)`,
);
