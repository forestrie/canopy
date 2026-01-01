#!/usr/bin/env node
/**
 * Generate UUID-like log IDs that hash to specific shards using djb2.
 * 
 * This script generates sets of log IDs for performance testing where
 * we want controlled distribution across shards.
 * 
 * Usage:
 *   node generate-shard-balanced-ids.js
 * 
 * Output: JSON with log ID sets for different "logs per shard" configurations
 */

import crypto from 'crypto';

// djb2 hash function - must match @canopy/forestrie-sharding
function hashLogId(logId) {
  let hash = 5381;
  for (let i = 0; i < logId.length; i++) {
    const char = logId.charCodeAt(i);
    // hash = ((hash << 5) + hash) + char = hash * 33 + char
    hash = ((hash << 5) + hash + char) >>> 0; // Keep as 32-bit unsigned
  }
  return hash >>> 0; // Ensure unsigned
}

function shardIndexForLog(logId, shardCount) {
  return hashLogId(logId) % shardCount;
}

// Generate a random UUID-like string
function generateUUID() {
  return crypto.randomUUID();
}

// Find a UUID that hashes to a specific shard
function findUUIDForShard(targetShard, shardCount, maxAttempts = 100000) {
  for (let i = 0; i < maxAttempts; i++) {
    const uuid = generateUUID();
    if (shardIndexForLog(uuid, shardCount) === targetShard) {
      return uuid;
    }
  }
  throw new Error(`Could not find UUID for shard ${targetShard} after ${maxAttempts} attempts`);
}

// Generate a set of log IDs with specific distribution
function generateLogSet(logsPerShard, shardCount) {
  const logIds = [];
  
  for (let shard = 0; shard < shardCount; shard++) {
    for (let i = 0; i < logsPerShard; i++) {
      const uuid = findUUIDForShard(shard, shardCount);
      logIds.push({
        id: uuid,
        shard: shard,
        hash: hashLogId(uuid)
      });
    }
  }
  
  return logIds;
}

// Main
const SHARD_COUNT = 4;
const LOGS_PER_SHARD_OPTIONS = [1, 2, 3];

console.log('Generating shard-balanced log IDs...\n');
console.log(`Shard count: ${SHARD_COUNT}`);
console.log(`Logs per shard options: ${LOGS_PER_SHARD_OPTIONS.join(', ')}\n`);

const result = {
  shardCount: SHARD_COUNT,
  generated: new Date().toISOString(),
  sets: {}
};

for (const logsPerShard of LOGS_PER_SHARD_OPTIONS) {
  const totalLogs = logsPerShard * SHARD_COUNT;
  console.log(`\n=== ${logsPerShard} log(s) per shard (${totalLogs} total) ===`);
  
  const logSet = generateLogSet(logsPerShard, SHARD_COUNT);
  
  // Display the distribution
  for (const log of logSet) {
    console.log(`  ${log.id} -> shard ${log.shard}`);
  }
  
  // Store just the IDs in order (grouped by shard)
  result.sets[logsPerShard] = logSet.map(l => l.id);
}

// Output as workflow-friendly format
console.log('\n\n=== WORKFLOW ENV VARS ===\n');

for (const [logsPerShard, ids] of Object.entries(result.sets)) {
  const totalLogs = ids.length;
  console.log(`# ${logsPerShard} log(s) per shard (${totalLogs} total)`);
  ids.forEach((id, i) => {
    const varName = `CANOPY_PERF_LOG_${logsPerShard}LPS_${i}`;
    console.log(`${varName}: ${id}`);
  });
  console.log('');
}

// Also output as JSON for reference
console.log('\n=== JSON ===\n');
console.log(JSON.stringify(result, null, 2));
