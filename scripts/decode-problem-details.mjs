#!/usr/bin/env node

/**
 * Decode and pretty-print CBOR-encoded Problem Details object from stdin
 *
 * Reads CBOR binary data from stdin, decodes it, and outputs formatted JSON
 * to stdout. Used for displaying error responses from the SCRAPI API.
 */

import cbor from 'cbor';

// Read all data from stdin
const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}

const inputBuffer = Buffer.concat(chunks);

if (inputBuffer.length === 0) {
  console.error('No input received on stdin');
  process.exit(1);
}

try {
  // Decode CBOR data
  const decoded = cbor.decode(inputBuffer);

  // Pretty print as JSON
  console.log(JSON.stringify(decoded, null, 2));
} catch (error) {
  console.error('Failed to decode CBOR data:', error.message);
  process.exit(1);
}
