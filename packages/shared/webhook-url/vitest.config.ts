/** Vitest config for @canopy/webhook-url validation tests. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
