import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSupportedChainsRpc } from "../../../libs/chain-rpc/resolve-for-deploy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultChainsTemplatePath = resolve(
  scriptDir,
  "../config/supported-chains.jsonc",
);

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
      if (c === "\\") {
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
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
  const jsonValue = JSON.stringify(value);
  const re = new RegExp(
    `("${key}"\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|[^,\\n]+)`,
  );
  if (re.test(block)) return block.replace(re, `$1${jsonValue}`);
  const insert = `\n        "${key}": ${jsonValue},`;
  return block.replace(/\n\s*}$/, `${insert}\n      }`);
}

function stripJsoncComments(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadSupportedChainsRpcResolved() {
  const envRaw = process.env.SUPPORTED_CHAINS_RPC?.trim();
  const templatePath =
    process.env.SUPPORTED_CHAINS_TEMPLATE?.trim() || defaultChainsTemplatePath;
  const raw = envRaw || stripJsoncComments(readFileSync(templatePath, "utf8"));
  const config = parseSupportedChainsRpc(raw, {
    resolveEnv: true,
    env: process.env,
  });
  return JSON.stringify(config);
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
  const re = /(\{\s*\n\s*"name"\s*:\s*"[^"]*",)/;
  if (!re.test(envBlock)) fail("Could not find env name for injection.");
  return envBlock.replace(re, `$1${insertText}`);
}

function parseHostnames(primary, aliasesCsv) {
  const seen = new Set();
  const hostnames = [];
  const add = (value) => {
    const host = hostnameFromFqdnOrUrl(value);
    if (!host || seen.has(host)) return;
    seen.add(host);
    hostnames.push(host);
  };
  add(primary);
  if (aliasesCsv) {
    for (const part of aliasesCsv.split(",")) {
      add(part);
    }
  }
  return hostnames;
}

function clearRoutes(envBlock) {
  return removePropertyWithComma(envBlock, "routes", "[", "]");
}

function setR2BucketName(envBlock, bindingName, bucketName) {
  if (!bucketName) return envBlock;
  const re = new RegExp(
    `("binding"\\s*:\\s*"${bindingName}"[\\s\\S]*?"bucket_name"\\s*:\\s*)"[^"]*"`,
  );
  return envBlock.replace(re, `$1"${bucketName}"`);
}

function setDurableObjectScript(envBlock, bindingName, scriptName) {
  if (!scriptName) return envBlock;
  const re = new RegExp(
    `("name"\\s*:\\s*"${bindingName}"[\\s\\S]*?"script_name"\\s*:\\s*)"[^"]*"`,
  );
  if (re.test(envBlock)) return envBlock.replace(re, `$1"${scriptName}"`);
  const classRe = new RegExp(
    `("name"\\s*:\\s*"${bindingName}"[\\s\\S]*?"class_name"\\s*:\\s*"[^"]*")`,
  );
  return envBlock.replace(
    classRe,
    `$1,\n            "script_name": "${scriptName}"`,
  );
}

function setQueueName(envBlock, bindingName, queueName) {
  if (!queueName) return envBlock;
  const re = new RegExp(
    `("binding"\\s*:\\s*"${bindingName}"[\\s\\S]*?"queue"\\s*:\\s*)"[^"]*"`,
  );
  return envBlock.replace(re, `$1"${queueName}"`);
}

function x402SettlementScriptFromCanopyId(canopyId) {
  if (!canopyId) return "";
  const match = canopyId.match(/^canopy-([^-]+)/);
  if (!match) return "";
  return `x402-settlement-${match[1]}`;
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
const vars = blockForProperty(envBlock, "vars", "{", "}");
if (!vars) fail(`Could not find env.${envName}.vars block in wrangler config.`);

let varsBlock = vars.text;
varsBlock = setStringProperty(varsBlock, "CANOPY_ID", process.env.CANOPY_ID);
varsBlock = setStringProperty(
  varsBlock,
  "FOREST_PROJECT_ID",
  process.env.FOREST_PROJECT_ID,
);
varsBlock = setStringProperty(
  varsBlock,
  "CUSTODIAN_URL",
  process.env.CUSTODIAN_URL,
);
varsBlock = setStringProperty(
  varsBlock,
  "DELEGATION_COORDINATOR_URL",
  process.env.DELEGATION_COORDINATOR_URL,
);
varsBlock = setStringProperty(
  varsBlock,
  "UNIVOCITY_SERVICE_URL",
  process.env.UNIVOCITY_SERVICE_URL,
);
varsBlock = setStringProperty(
  varsBlock,
  "SUPPORTED_CHAINS_RPC",
  loadSupportedChainsRpcResolved(),
);
envBlock = replaceRange(envBlock, vars, varsBlock);
envBlock = setR2BucketName(
  envBlock,
  "R2_MMRS",
  process.env.R2_MMRS_BUCKET_NAME,
);
if (process.env.R2_GRANTS_BUCKET_NAME) {
  envBlock = setR2BucketName(
    envBlock,
    "R2_GRANTS",
    process.env.R2_GRANTS_BUCKET_NAME,
  );
}
envBlock = setDurableObjectScript(
  envBlock,
  "SEQUENCING_QUEUE",
  process.env.SEQUENCING_QUEUE_SCRIPT_NAME,
);
if (process.env.CANOPY_ID) {
  envBlock = setQueueName(
    envBlock,
    "X402_SETTLEMENT_QUEUE",
    `${process.env.CANOPY_ID}-x402-settlement`,
  );
  envBlock = setDurableObjectScript(
    envBlock,
    "X402_SETTLEMENT_DO",
    x402SettlementScriptFromCanopyId(process.env.CANOPY_ID),
  );
}

const canopyFqdn = hostnameFromFqdnOrUrl(process.env.CANOPY_FQDN);
if (!canopyFqdn) {
  fail("CANOPY_FQDN is required for canopy-api deploy runtime config.");
}
const routeHostnames = parseHostnames(
  canopyFqdn,
  process.env.CANOPY_FQDN_ALIASES,
);
envBlock = clearRoutes(envBlock);

config = replaceRange(config, target, envBlock);
writeFileSync(outputPath, config);
console.log(
  `Wrote ${outputPath} for env ${envName} (custom domains via wrangler --domain: ${routeHostnames.join(", ")})`,
);
