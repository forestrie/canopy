import { encode as encodeCbor } from "cbor-x";

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

function trimBase(url: string): string {
  return url.trim().replace(/\/$/, "");
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
  const base = trimBase(env.baseUrl);
  const keySeg = encodeURIComponent(CUSTODIAN_BOOTSTRAP_KEY_ID);
  const encoded = encodeCbor({ payload: payloadBytes });
  const u8 =
    encoded instanceof Uint8Array
      ? encoded
      : new Uint8Array(encoded as ArrayLike<number>);
  const bodyBuf = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  const res = await fetch(`${base}/api/keys/${keySeg}/sign`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.token}`,
      "Content-Type": "application/cbor",
      Accept: 'application/cose; cose-type="cose-sign1"',
    },
    body: bodyBuf,
  });
  if (!res.ok) {
    throw new Error(
      `Custodian sign failed: ${res.status} ${(await res.text()).slice(0, 200)}`,
    );
  }
  return new Uint8Array(await res.arrayBuffer());
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
