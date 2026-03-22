#!/usr/bin/env node
/**
 * Generate UUID log IDs that hash to specific shards (djb2, matches ingress sharding).
 *
 * Legacy (no flags): print human-readable sets for 1/2/3 logs-per-shard, env-style names, and JSON.
 *
 * CI / automation:
 *   node generate-shard-balanced-ids.js --logs-per-shard 2 --format csv
 *   → single comma-separated line on stdout (for CANOPY_PERF_LOG_IDS / GITHUB_OUTPUT).
 *
 *   --shard-count <n>   default 4 (must match forestrie-ingress QUEUE_SHARD_COUNT)
 *   --format csv|env|json|human
 */

import crypto from "crypto";
import process from "node:process";

function hashLogId(logId) {
  let hash = 5381;
  for (let i = 0; i < logId.length; i++) {
    const char = logId.charCodeAt(i);
    hash = ((hash << 5) + hash + char) >>> 0;
  }
  return hash >>> 0;
}

function shardIndexForLog(logId, shardCount) {
  return hashLogId(logId) % shardCount;
}

function generateUUID() {
  return crypto.randomUUID();
}

function findUUIDForShard(targetShard, shardCount, maxAttempts = 100_000) {
  for (let i = 0; i < maxAttempts; i++) {
    const uuid = generateUUID();
    if (shardIndexForLog(uuid, shardCount) === targetShard) {
      return uuid;
    }
  }
  throw new Error(
    `Could not find UUID for shard ${targetShard} after ${maxAttempts} attempts`,
  );
}

function generateLogSet(logsPerShard, shardCount) {
  const logIds = [];
  for (let shard = 0; shard < shardCount; shard++) {
    for (let i = 0; i < logsPerShard; i++) {
      const uuid = findUUIDForShard(shard, shardCount);
      logIds.push({
        id: uuid,
        shard,
        hash: hashLogId(uuid),
      });
    }
  }
  return logIds;
}

function parseArgs(argv) {
  const out = {
    logsPerShard: null,
    shardCount: 4,
    format: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      continue;
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--logs-per-shard") {
      out.logsPerShard = parseInt(argv[++i], 10);
    } else if (a === "--shard-count") {
      out.shardCount = parseInt(argv[++i], 10);
    } else if (a === "--format") {
      out.format = argv[++i];
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return out;
}

function usage() {
  console.error(`Usage:
  node generate-shard-balanced-ids.js
    Interactive: all logs-per-shard presets (1,2,3), human + env + JSON.

  node generate-shard-balanced-ids.js --logs-per-shard <1|2|3> [--shard-count 4] [--format csv|env|json|human]
    Machine mode: default --format is csv (one line, comma-separated UUIDs).`);
}

function runMachineMode(logsPerShard, shardCount, format) {
  if (![1, 2, 3].includes(logsPerShard)) {
    console.error("--logs-per-shard must be 1, 2, or 3");
    process.exit(1);
  }
  if (!Number.isFinite(shardCount) || shardCount < 1) {
    console.error("--shard-count must be a positive integer");
    process.exit(1);
  }
  const fmt = format || "csv";
  const logSet = generateLogSet(logsPerShard, shardCount);
  const ids = logSet.map((l) => l.id);

  if (fmt === "csv") {
    process.stdout.write(ids.join(","));
    return;
  }
  if (fmt === "json") {
    process.stdout.write(
      JSON.stringify({
        logIds: ids,
        logsPerShard,
        shardCount,
        generated: new Date().toISOString(),
      }),
    );
    return;
  }
  if (fmt === "env") {
    ids.forEach((id, i) => {
      console.log(`CANOPY_PERF_LOG_${logsPerShard}LPS_${i}=${id}`);
    });
    return;
  }
  if (fmt === "human") {
    console.error(
      `Shard count: ${shardCount}; ${logsPerShard} log(s) per shard (${ids.length} total)\n`,
    );
    for (const log of logSet) {
      console.error(`  ${log.id} -> shard ${log.shard}`);
    }
    return;
  }
  console.error(`Unknown --format ${fmt} (use csv, env, json, human)`);
  process.exit(1);
}

function runLegacyMode() {
  const SHARD_COUNT = 4;
  const LOGS_PER_SHARD_OPTIONS = [1, 2, 3];

  console.log("Generating shard-balanced log IDs...\n");
  console.log(`Shard count: ${SHARD_COUNT}`);
  console.log(`Logs per shard options: ${LOGS_PER_SHARD_OPTIONS.join(", ")}\n`);

  const result = {
    shardCount: SHARD_COUNT,
    generated: new Date().toISOString(),
    sets: {},
  };

  for (const logsPerShard of LOGS_PER_SHARD_OPTIONS) {
    const totalLogs = logsPerShard * SHARD_COUNT;
    console.log(`\n=== ${logsPerShard} log(s) per shard (${totalLogs} total) ===`);

    const logSet = generateLogSet(logsPerShard, SHARD_COUNT);
    for (const log of logSet) {
      console.log(`  ${log.id} -> shard ${log.shard}`);
    }
    result.sets[logsPerShard] = logSet.map((l) => l.id);
  }

  console.log("\n\n=== WORKFLOW ENV VARS (optional; CI synthesizes via --format csv) ===\n");
  for (const [logsPerShard, ids] of Object.entries(result.sets)) {
    const totalLogs = ids.length;
    console.log(`# ${logsPerShard} log(s) per shard (${totalLogs} total)`);
    ids.forEach((id, i) => {
      const varName = `CANOPY_PERF_LOG_${logsPerShard}LPS_${i}`;
      console.log(`${varName}: ${id}`);
    });
    console.log("");
  }

  console.log("\n=== JSON ===\n");
  console.log(JSON.stringify(result, null, 2));
}

const args = parseArgs(process.argv);
if (args.help) {
  usage();
  process.exit(0);
}

if (args.logsPerShard != null) {
  runMachineMode(args.logsPerShard, args.shardCount, args.format);
} else {
  if (args.format != null || args.shardCount !== 4) {
    console.error(
      "With no --logs-per-shard, only default legacy mode runs; omit --format / --shard-count.",
    );
    process.exit(1);
  }
  runLegacyMode();
}
