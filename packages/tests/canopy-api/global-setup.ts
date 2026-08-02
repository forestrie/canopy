import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";
import { runPinCoherenceGate } from "./src/pin-coherence-gate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runIdFile = resolve(__dirname, ".e2e-run-id");

export default async function globalSetup(): Promise<void> {
  const id = uuidv7();
  writeFileSync(runIdFile, id, "utf8");
  process.env.E2E_RUN_ID = id;

  // Pin coherence BEFORE any spec (devdocs plan-2608-03, FOR-516). Global
  // setup is the right home: it runs once, ahead of every project, with the
  // pins already exported by the tier and the kit loadable the way specs load
  // it. A bare node script cannot — the workspace kit's deps resolve to
  // TypeScript source.
  await runPinCoherenceGate();
}
