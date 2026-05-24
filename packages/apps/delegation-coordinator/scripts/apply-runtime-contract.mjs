/**
 * Inject GitHub Environment / deploy-time vars into delegation-coordinator wrangler config.
 * Coordinator hostname: Wrangler route with custom_domain: true (ADR-0002).
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

const envName = args.get("env") ?? process.env.DEPLOY_ENV ?? "dev";
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

function blockForProperty(text, property, openChar, closeChar, start = 0, end = text.length) {
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

function hostnameFromUrl(url) {
  if (!url) return "";
  try {
    return new URL(url.trim()).hostname;
  } catch {
    fail(`Invalid DELEGATION_COORDINATOR_URL: ${url}`);
  }
}

function removePropertyWithComma(text, property, openChar, closeChar) {
  const prop = `"${property}"`;
  const idx = text.indexOf(prop);
  if (idx < 0) return text;
  const open = text.indexOf(openChar, idx + prop.length);
  if (open < 0) return text;
  const close = findMatching(text, open, openChar, closeChar);
  if (close < 0) return text;
  let start = idx;
  while (start > 0 && /[\s]/.test(text[start - 1])) start -= 1;
  if (start > 0 && text[start - 1] === ",") start -= 1;
  let end = close + 1;
  while (end < text.length && /[\s]/.test(text[end])) end += 1;
  if (text[end] === ",") end += 1;
  return text.slice(0, start) + text.slice(end);
}

function insertAfterEnvName(envBlock, insertText) {
  const re = /(\{\s*(?:\/\/[^\n]*\n\s*)?"name"\s*:\s*"[^"]*",)/;
  if (!re.test(envBlock)) fail("Could not find env name for injection.");
  return envBlock.replace(re, `$1${insertText}`);
}

function setCoordinatorCustomDomain(envBlock, hostname) {
  if (!hostname) fail("DELEGATION_COORDINATOR_URL hostname is required.");
  envBlock = removePropertyWithComma(envBlock, "custom_domains", "[", "]");
  const zone = hostname.split(".").slice(-2).join(".");
  const body = `[
        {
          "pattern": "${hostname}/*",
          "zone_name": "${zone}",
          "custom_domain": true,
        },
      ]`;
  const existing = blockForProperty(envBlock, "routes", "[", "]");
  if (existing) {
    return replaceRange(envBlock, existing, body);
  }
  const insert = `\n      "routes": ${body},`;
  return insertAfterEnvName(envBlock, insert);
}

let config = readFileSync(inputPath, "utf8");
const envs = blockForProperty(config, "env", "{", "}");
if (!envs) fail("Could not find top-level env block in wrangler config.");
const target = blockForProperty(config, envName, "{", "}", envs.start, envs.end);
if (!target) fail(`Could not find env.${envName} block in wrangler config.`);

let envBlock = target.text;
const vars = blockForProperty(envBlock, "vars", "{", "}");
if (!vars) fail(`Could not find env.${envName}.vars block in wrangler config.`);

let varsBlock = vars.text;
varsBlock = setStringProperty(varsBlock, "CUSTODIAN_URL", process.env.CUSTODIAN_URL);
envBlock = replaceRange(envBlock, vars, varsBlock);

const coordinatorHost = hostnameFromUrl(process.env.DELEGATION_COORDINATOR_URL);
if (!coordinatorHost) {
  fail("DELEGATION_COORDINATOR_URL is required for delegation-coordinator deploy.");
}
envBlock = setCoordinatorCustomDomain(envBlock, coordinatorHost);

config = replaceRange(config, target, envBlock);
writeFileSync(outputPath, config);
console.log(`Wrote ${outputPath} for env ${envName} (custom_domain route ${coordinatorHost})`);
