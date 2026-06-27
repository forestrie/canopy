/** Vitest config for `@forestrie/delegation-cose` unit tests (Node, no Workers). */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
