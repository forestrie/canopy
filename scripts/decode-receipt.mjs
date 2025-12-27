#!/usr/bin/env node
/**
 * Decode a SCITT receipt (COSE_Sign1) and display in CDDL-like diagnostic notation.
 */
import fs from 'fs';
import { decode } from 'cbor-x';

const file = process.argv[2] || 'resolve-receipt.cbor';
const data = fs.readFileSync(file);
const receipt = decode(data);

function toHex(buf) {
  return Buffer.from(buf).toString('hex');
}

function formatValue(v, indent = 0) {
  const pad = '  '.repeat(indent);
  if (v === null) return 'nil';
  if (v === undefined) return 'undefined';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'string') return `"${v}"`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return `h'${toHex(v)}'`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map(item => `${pad}  ${formatValue(item, indent + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (v instanceof Map) {
    const entries = [...v.entries()].map(([k, val]) => 
      `${pad}  ${formatValue(k, indent + 1)}: ${formatValue(val, indent + 1)}`
    );
    return `{\n${entries.join(',\n')}\n${pad}}`;
  }
  if (typeof v === 'object' && v !== null) {
    // Check for tagged value
    if (v.tag !== undefined && v.value !== undefined) {
      return `${v.tag}(${formatValue(v.value, indent)})`;
    }
    const entries = Object.entries(v).map(([k, val]) => 
      `${pad}  ${k}: ${formatValue(val, indent + 1)}`
    );
    return `{\n${entries.join(',\n')}\n${pad}}`;
  }
  return String(v);
}

// COSE_Sign1 = [protected, unprotected, payload, signature]
const [protectedHdr, unprotectedHdr, payload, signature] = receipt;

// Decode the protected header
const protectedDecoded = decode(protectedHdr);

console.log('/ COSE_Sign1 SCITT Receipt /');
console.log('18([');
console.log(`  / protected (${toHex(protectedHdr).length / 2} bytes) /`);

// Show decoded protected header
console.log('  / decoded protected header: /');
console.log(`  ${formatValue(protectedDecoded, 1)},`);
console.log('');

console.log('  / unprotected /');
console.log(`  ${formatValue(unprotectedHdr, 1)},`);
console.log('');

console.log(`  / payload / ${payload === null ? 'nil' : formatValue(payload)},`);
console.log('');

console.log(`  / signature (${signature.length} bytes) /`);
console.log(`  h'${toHex(signature)}'`);
console.log('])');

// Additional info about protected header fields
console.log('\n/ Protected Header Labels /');
console.log('/ 1 = alg (algorithm) /');
console.log('/ 4 = kid (key ID) /');
console.log('/ -47 (0x2e) = SCITT-specific /');

if (protectedDecoded instanceof Map) {
  const alg = protectedDecoded.get(1);
  const kid = protectedDecoded.get(4);
  console.log(`\n/ alg: ${alg} /`);
  if (kid) console.log(`/ kid: ${Buffer.from(kid).toString('utf8')} /`);
}
