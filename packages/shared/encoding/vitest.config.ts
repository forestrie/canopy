/** Vitest config for @canopy/encoding unit and go-cose golden-vector tests. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
});
