import { afterEach, describe, expect, it } from "vitest";

import {
  resetSupportedChainsCacheForTests,
  rpcUrlsForEnvChainId,
  supportedChainIdsForEnv,
} from "../src/env/supported-chains-for-env.js";

describe("supportedChainsConfigForEnv", () => {
  afterEach(() => {
    resetSupportedChainsCacheForTests();
  });

  const env = {
    SUPPORTED_CHAINS_RPC: JSON.stringify({
      "84532": ["https://a", "https://b"],
    }),
  };

  it("lists supported chain ids", () => {
    expect(supportedChainIdsForEnv(env)).toEqual(["84532"]);
  });

  it("returns rpc urls for a supported chain", () => {
    expect(rpcUrlsForEnvChainId(env, "84532")).toEqual([
      "https://a",
      "https://b",
    ]);
  });
});
