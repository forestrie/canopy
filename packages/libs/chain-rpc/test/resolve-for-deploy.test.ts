/**
 * Deploy-time JSONC helpers for `supported-chains.jsonc` template parsing.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  jsoncToJson,
  parseSupportedChainsRpc,
} from "../resolve-for-deploy.mjs";

const chainsTemplatePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/canopy-api/config/supported-chains.jsonc",
);

describe("jsoncToJson", () => {
  it("parses supported-chains.jsonc template (comments and trailing commas)", () => {
    const raw = readFileSync(chainsTemplatePath, "utf8");
    const json = jsoncToJson(raw);
    expect(() => JSON.parse(json)).not.toThrow();
    const config = parseSupportedChainsRpc(json, { resolveEnv: false });
    expect(config["84532"]).toHaveLength(2);
  });
});
