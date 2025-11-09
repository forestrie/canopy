#!/usr/bin/env node

/**
 * Generate a COSE Sign1 message with random UUID payload
 * Outputs the binary COSE message to stdout
 *
 * Structure (CBOR array of 4 elements):
 * [
 *   protected: bstr (empty),
 *   unprotected: {},
 *   payload: bstr (message with UUID),
 *   signature: bstr (empty for testing)
 * ]
 */

import { v4 as uuidv4 } from 'uuid';

// Generate random UUID for the message
const uuid = uuidv4();
const message = `Hello from ${uuid}`;
const messageBytes = Buffer.from(message, 'utf8');

// Manually construct COSE Sign1 CBOR structure
const coseSign1 = Buffer.concat([
  Buffer.from([0x84]),           // CBOR array of 4 elements
  Buffer.from([0x40]),           // protected headers: empty bstr
  Buffer.from([0xa0]),           // unprotected headers: empty map

  // payload: bstr with length prefix
  messageBytes.length < 24
    ? Buffer.from([0x40 + messageBytes.length])  // Small bstr (< 24 bytes)
    : Buffer.from([0x58, messageBytes.length]),  // bstr with 1-byte length
  messageBytes,

  Buffer.from([0x40])            // signature: empty bstr (for testing)
]);

// Output binary COSE message to stdout
process.stdout.write(coseSign1);
