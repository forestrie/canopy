/** Vitest config for `@forestrie/chain-rpc` unit tests. */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
