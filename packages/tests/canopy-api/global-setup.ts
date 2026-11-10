import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v7 as uuidv7 } from "uuid";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runIdFile = resolve(__dirname, ".e2e-run-id");

export default async function globalSetup(): Promise<void> {
  const id = uuidv7();
  writeFileSync(runIdFile, id, "utf8");
  process.env.E2E_RUN_ID = id;
}
