/**
 * Inject per-lane x402-settlement Worker name, queue consumer and chain config
 * from the forest-1 consumer contract (plan-2607-39 Phase 1).
 *
 * Until this existed, x402-settlement was the only canopy Worker deployed with
 * bare `wrangler deploy --env=<ENV>` against checked-in literals. Its queue
 * consumer name had to be kept in lockstep by hand with the queue that
 * canopy-api derives from CANOPY_ID at deploy time. It was not, and Lane B ran
 * bound to Lane A's settlement pipeline (FOR-443).
 *
 * The producer (canopy-api) and the consumer (this worker) now read the same
 * two contract values, so they cannot drift apart.
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
const outputPath = resolve(args.get("out") ?? "wrangler.runtime.jsonc");

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

function envWorkerNamePattern() {
  return /(\{\s*(?:\/\/[^\n]*\n\s*)*"name"\s*:\s*)"[^"]*"/;
}

function setWorkerName(envBlock, scriptName) {
  const re = envWorkerNamePattern();
  if (!re.test(envBlock))
    fail("Could not find env worker name for script rename.");
  return envBlock.replace(re, `$1"${scriptName}"`);
}

/**
 * Rewrite the queue name on every consumer entry. There is exactly one today,
 * but rewriting all of them keeps the script honest if a second is added.
 */
function setQueueConsumers(envBlock, queueName) {
  const queues = blockForProperty(envBlock, "queues", "{", "}");
  if (!queues) fail("Could not find queues block in env config.");
  const consumers = blockForProperty(queues.text, "consumers", "[", "]");
  if (!consumers) fail("Could not find queues.consumers in env config.");
  const re = /("queue"\s*:\s*)"[^"]*"/g;
  if (!re.test(consumers.text))
    fail("Could not find a queue consumer name to rewrite.");
  const rewritten = consumers.text.replace(
    /("queue"\s*:\s*)"[^"]*"/g,
    `$1"${queueName}"`,
  );
  const queuesBlock = replaceRange(queues.text, consumers, rewritten);
  return replaceRange(envBlock, queues, queuesBlock);
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

const scriptName = process.env.X402_SETTLEMENT_SCRIPT_NAME?.trim();
const queueName = process.env.X402_SETTLEMENT_QUEUE_NAME?.trim();
if (!scriptName) {
  fail("X402_SETTLEMENT_SCRIPT_NAME is required for x402-settlement deploy.");
}
if (!queueName) {
  fail("X402_SETTLEMENT_QUEUE_NAME is required for x402-settlement deploy.");
}

envBlock = setWorkerName(envBlock, scriptName);
envBlock = setQueueConsumers(envBlock, queueName);

const vars = blockForProperty(envBlock, "vars", "{", "}");
if (vars) {
  let varsBlock = vars.text;
  // CANOPY_ID is metadata here (it surfaces in /health); it no longer selects
  // any binding. X402_NETWORK and X402_FACILITATOR_URL must match canopy-api's
  // resolved values or the 402 challenge and the settlement disagree.
  varsBlock = setStringProperty(varsBlock, "CANOPY_ID", process.env.CANOPY_ID);
  varsBlock = setStringProperty(
    varsBlock,
    "X402_NETWORK",
    process.env.X402_NETWORK,
  );
  varsBlock = setStringProperty(
    varsBlock,
    "X402_FACILITATOR_URL",
    process.env.X402_FACILITATOR_URL,
  );
  envBlock = replaceRange(envBlock, vars, varsBlock);
}

config = replaceRange(config, target, envBlock);
writeFileSync(outputPath, config);
console.log(
  `Wrote ${outputPath} for env ${envName} (worker ${scriptName}, queue ${queueName})`,
);

// Emit the RESOLVED facilitator so the deploy step can decide whether CDP
// credentials are required, rather than guessing from an env var that may not
// be part of the contract. Machine-readable, one key per line.
const resolvedFacilitator =
  /"X402_FACILITATOR_URL"\s*:\s*"([^"]*)"/.exec(envBlock)?.[1] ?? "";
const resolvedNetwork =
  /"X402_NETWORK"\s*:\s*"([^"]*)"/.exec(envBlock)?.[1] ?? "";
console.log(`resolved:X402_FACILITATOR_URL=${resolvedFacilitator}`);
console.log(`resolved:X402_NETWORK=${resolvedNetwork}`);
