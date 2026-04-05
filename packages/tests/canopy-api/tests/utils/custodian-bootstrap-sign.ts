import { encode as encodeCbor } from "cbor-x";
import { postCustodianSignRawPayloadBytes } from "./custodian-sign-payload.js";

const CUSTODIAN_BOOTSTRAP_KEY_ID = ":bootstrap";

export function custodianBootstrapSignEnv(): {
  baseUrl: string;
  token: string;
} | null {
  const baseUrl = process.env.CUSTODIAN_URL?.trim();
  const token = process.env.CUSTODIAN_BOOTSTRAP_APP_TOKEN?.trim();
  if (!baseUrl || !token) return null;
  return { baseUrl, token };
}

/**
 * POST /api/keys/:bootstrap/sign — CBOR `{ payload }` (bytes); response is raw COSE Sign1
 * (same contract as canopy-api `postCustodianSignGrantPayload`).
 */
export async function postCustodianBootstrapSignPayloadBytes(
  payloadBytes: Uint8Array,
): Promise<Uint8Array> {
  const env = custodianBootstrapSignEnv();
  if (!env) {
    throw new Error(
      "CUSTODIAN_URL and CUSTODIAN_BOOTSTRAP_APP_TOKEN must be set for Custodian sign",
    );
  }
  return postCustodianSignRawPayloadBytes({
    baseUrl: env.baseUrl,
    bearerToken: env.token,
    keyIdSegment: CUSTODIAN_BOOTSTRAP_KEY_ID,
    payloadBytes,
  });
}

/** Minimal deterministic statement artifact (CBOR) for e2e. */
export function e2eFirstStatementPayload(): Uint8Array {
  const encoded = encodeCbor({
    kind: "canopy-e2e-first-statement",
    v: 1,
  });
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  return new Uint8Array(u8);
}
