#!/usr/bin/env node
/**
 * Generate a COSE Sign1 message and output to stdout.
 *
 * LEGACY: Outputs COSE Sign1 with **empty protected** (no kid).
 * Does not satisfy the current statement contract for grant-based auth.
 * For grant flow use the canonical encoder in @canopy/encoding (encodeCoseSign1Statement).
 *
 * Usage:
 *   pnpm --filter @canopy/scripts run gen-cose-sign1              # Random UUID message
 *   pnpm --filter @canopy/scripts run gen-cose-sign1 -- "text"     # Custom message
 *   pnpm --filter @canopy/scripts run gen-cose-sign1 -- -f file.bin # Read message from file
 *
 * Structure (CBOR array of 4 elements):
 * [ protected: empty bstr, unprotected: {}, payload: bstr, signature: empty bstr ]
 */
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { encodeCborBstr } from "@canopy/encoding";

// pnpm run script -- arg1 arg2 → argv has "--" before user args; strip it
const raw = process.argv.slice(2);
const args = raw[0] === "--" ? raw.slice(1) : raw;
const baseDir = process.env.INIT_CWD || process.cwd();

let messageBytes: Uint8Array;

if (args.length === 0) {
  const uuid = uuidv4();
  const message = `Hello from ${uuid}`;
  messageBytes = new TextEncoder().encode(message);
} else if (args.length === 1) {
  if (args[0] === "-f") {
    console.error("Usage: gen-cose-sign1 [--] [-f <file> | <message>]");
    console.error("  With -f, a file path must follow.");
    process.exit(1);
  }
  messageBytes = new TextEncoder().encode(args[0]);
} else if (args.length === 2 && args[0] === "-f") {
  const filePath = args[1].startsWith("/") ? args[1] : join(baseDir, args[1]);
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${args[1]}`);
    process.exit(1);
  }
  messageBytes = new Uint8Array(readFileSync(filePath));
} else {
  console.error("Usage: gen-cose-sign1 [--] [-f <file> | <message>]");
  process.exit(1);
}

// COSE Sign1: array(4), empty protected bstr (0x40), empty map (0xa0), payload bstr, empty signature bstr (0x40)
const payloadBstr = encodeCborBstr(messageBytes);
const coseSign1 = new Uint8Array([0x84, 0x40, 0xa0, ...payloadBstr, 0x40]);

process.stdout.write(Buffer.from(coseSign1));
