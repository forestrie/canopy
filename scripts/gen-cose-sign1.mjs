#!/usr/bin/env node

/**
 * Generate a COSE Sign1 message and output to stdout.
 *
 * Usage:
 *   node gen-cose-sign1.mjs              # Random UUID message
 *   node gen-cose-sign1.mjs "text"       # Use provided text as message
 *   node gen-cose-sign1.mjs -f file.bin  # Read message bytes from file
 *
 * Structure (CBOR array of 4 elements):
 * [
 *   protected: bstr (empty),
 *   unprotected: {},
 *   payload: bstr (message),
 *   signature: bstr (empty for testing)
 * ]
 */

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

// Parse command line arguments
const args = process.argv.slice(2);
let messageBytes;

if (args.length === 0) {
  // No arguments: generate random UUID message
  const uuid = uuidv4();
  const message = `Hello from ${uuid}`;
  messageBytes = Buffer.from(message, 'utf8');
} else if (args.length === 1) {
  // One argument: treat as text message
  messageBytes = Buffer.from(args[0], 'utf8');
} else if (args.length === 2) {
  // Two arguments: require -f <file>
  if (args[0] !== '-f') {
    console.error('Usage: gen-cose-sign1.mjs [-f <file> | <message>]');
    console.error('  With two arguments, first must be -f');
    process.exit(1);
  }
  const filePath = args[1];
  if (!fs.existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }
  messageBytes = fs.readFileSync(filePath);
} else {
  console.error('Usage: gen-cose-sign1.mjs [-f <file> | <message>]');
  process.exit(1);
}

/**
 * Encode a byte length as CBOR bstr header.
 * Supports lengths up to 65535 (2-byte length prefix).
 */
function encodeBstrHeader(length) {
  if (length < 24) {
    return Buffer.from([0x40 + length]);
  } else if (length < 256) {
    return Buffer.from([0x58, length]);
  } else if (length < 65536) {
    return Buffer.from([0x59, (length >> 8) & 0xff, length & 0xff]);
  } else {
    throw new Error(`Message too large: ${length} bytes (max 65535)`);
  }
}

// Construct COSE Sign1 CBOR structure
const coseSign1 = Buffer.concat([
  Buffer.from([0x84]),           // CBOR array of 4 elements
  Buffer.from([0x40]),           // protected headers: empty bstr
  Buffer.from([0xa0]),           // unprotected headers: empty map
  encodeBstrHeader(messageBytes.length),
  messageBytes,
  Buffer.from([0x40])            // signature: empty bstr (for testing)
]);

// Output binary COSE message to stdout
process.stdout.write(coseSign1);
