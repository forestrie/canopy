import type { Env } from "../src/index";

declare module "cloudflare:test" {
  // ProvidedEnv controls the type of `import("cloudflare:test").env`
  // Note: External DO bindings (SEQUENCED_CONTENT, SEQUENCING_QUEUE) are omitted
  // because they reference workers that aren't available during isolated tests
  interface ProvidedEnv
    extends Omit<Env, "SEQUENCED_CONTENT" | "SEQUENCING_QUEUE"> {}
}
