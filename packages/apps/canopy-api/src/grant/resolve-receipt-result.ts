import type { RootVerifyKey } from "../env/trust-root-client.js";

export interface ResolveReceiptResult {
  verifyKeys: RootVerifyKey[];
}
