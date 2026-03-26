#!/usr/bin/env node
/**
 * Validate Mermaid diagram blocks in a markdown file.
 * Uses mermaid@10.2.3 for parse-only checks (no DOM).
 * Usage: node scripts/validate-mermaid.mjs <path-to.md>
 */

import { readFileSync } from 'fs';
import mermaid from 'mermaid';

function extractMermaidBlocks(content) {
  const blocks = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    blocks.push({ index: blocks.length + 1, code: m[1].trim() });
  }
  return blocks;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/validate-mermaid.mjs <path-to.md>');
    process.exit(2);
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Cannot read file: ${filePath}`, err.message);
    process.exit(1);
  }

  const blocks = extractMermaidBlocks(content);
  if (blocks.length === 0) {
    console.log(`${filePath}: no mermaid blocks found`);
    process.exit(0);
  }

  mermaid.initialize({ startOnLoad: false });

  let failed = 0;
  for (const { index, code } of blocks) {
    try {
      await mermaid.parse(code);
      console.log(`${filePath} diagram ${index}: OK (parse passed)`);
    } catch (err) {
      console.error(`${filePath} diagram ${index}: FAIL - ${err.message}`);
      failed++;
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
