import { request } from "@playwright/test";
import { setupBootstrapCoordinatorDelegation, signPendingBootstrapDelegations } from "./src/bootstrap-delegation-coordinator.js";
import { getBootstrapVariant } from "./src/e2e-bootstrap-variant.js";
import { assertCoordinatorApiE2eEnv } from "./src/coordinator-api-env.js";
const logId = process.env.EXP_LOG_ID!.trim();
const logIdHex32 = logId.replace(/-/g, "").toLowerCase();
const ctx = await request.newContext({ baseURL: "https://api-a.forest-2.forestrie.dev" });
const coordinator = assertCoordinatorApiE2eEnv();
const signingContext = await setupBootstrapCoordinatorDelegation({ request: ctx, logId, variant: getBootstrapVariant("es256") });
console.log("[daemon] ready");
const signedMaterialKeys = new Set<string>();
for (;;) {
  try {
    const res = await signPendingBootstrapDelegations({ request: ctx, coordinatorUrl: coordinator.baseUrl, coordinatorToken: coordinator.appToken, logId, logIdHex32, signingContext, signedMaterialKeys });
    if (res.signed > 0) console.log(`[daemon] signed=${res.signed} keys=${JSON.stringify([...signedMaterialKeys])}`);
  } catch (e) { console.error(`[daemon] ${e instanceof Error ? e.message : e}`); }
  await new Promise((r) => setTimeout(r, 300));
}
