#!/usr/bin/env node
/**
 * Decode a SCITT receipt (COSE_Sign1) and display in CDDL-like diagnostic notation.
 * Uses decodeCoseSign1 from @canopy/encoding (same structure as API).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { decode as decodeCbor } from "cbor-x";
import { decodeCoseSign1 } from "@canopy/encoding";

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
const baseDir = process.env.INIT_CWD || process.cwd();
const file = args[0] || "resolve-receipt.cbor";
const filePath = file.startsWith("/") ? file : join(baseDir, file);
const data = readFileSync(filePath);
const decoded = decodeCoseSign1(new Uint8Array(data));

if (!decoded) {
  console.error(
    "Failed to decode COSE Sign1 (malformed or not a 4-element array)",
  );
  process.exit(1);
}

const { protectedBstr, unprotected, payloadBstr, signature } = decoded;

function toHex(buf: Uint8Array): string {
  return Buffer.from(buf).toString("hex");
}

function formatValue(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (v === null) return "nil";
  if (v === undefined) return "undefined";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return v.toString();
  if (typeof v === "string") return `"${v}"`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return `h'${toHex(v)}'`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = v.map((item) => `${pad}  ${formatValue(item, indent + 1)}`);
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (v instanceof Map) {
    const entries = [...v.entries()].map(
      ([k, val]) =>
        `${pad}  ${formatValue(k, indent + 1)}: ${formatValue(val, indent + 1)}`,
    );
    return `{\n${entries.join(",\n")}\n${pad}}`;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if (o.tag !== undefined && o.value !== undefined) {
      return `${o.tag}(${formatValue(o.value, indent)})`;
    }
    const entries = Object.entries(o).map(
      ([k, val]) => `${pad}  ${k}: ${formatValue(val, indent + 1)}`,
    );
    return `{\n${entries.join(",\n")}\n${pad}}`;
  }
  return String(v);
}

// Decode protected header (CBOR bstr containing a map). Empty protected (0x40) decodes as empty bytes; avoid passing to decode.
const protectedDecoded =
  protectedBstr.length <= 1
    ? new Map<number, unknown>()
    : decodeCbor(protectedBstr);

console.log("/ COSE_Sign1 SCITT Receipt /");
console.log("18([");
console.log(`  / protected (${toHex(protectedBstr).length / 2} bytes) /`);
console.log("  / decoded protected header: /");
console.log(`  ${formatValue(protectedDecoded, 1)},`);
console.log("");
console.log("  / unprotected /");
console.log(`  ${formatValue(unprotected, 1)},`);
console.log("");
console.log(
  `  / payload / ${payloadBstr === null ? "nil" : formatValue(payloadBstr)},`,
);
console.log("");
console.log(`  / signature (${signature.length} bytes) /`);
console.log(`  h'${toHex(signature)}'`);
console.log("])");

console.log("\n/ Protected Header Labels /");
console.log("/ 1 = alg (algorithm) /");
console.log("/ 4 = kid (key ID) /");
console.log("/ -47 (0x2e) = SCITT-specific /");

if (protectedDecoded instanceof Map) {
  const alg = protectedDecoded.get(1);
  const kid = protectedDecoded.get(4);
  console.log(`\n/ alg: ${alg} /`);
  if (kid)
    console.log(`/ kid: ${Buffer.from(kid as Uint8Array).toString("utf8")} /`);
}
