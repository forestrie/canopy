/**
 * Client for forwarding forest genesis documents to the arbor univocity service
 * (`POST /api/forest/{R}/genesis`). Univocity owns genesis storage and anchors
 * each genesis key to the on-chain `bootstrapConfig()` for its forest's chain /
 * contract. Canopy forwards the canonical v1 genesis CBOR it built (curator
 * token -> univocity token) and keeps a local R2 copy that is authoritative for
 * reads until the subject log's first checkpoint, after which it may be expired.
 *
 * Status mapping (mirrors univocity handlePostGenesis):
 *   - 201 -> created
 *   - 409 -> exists (idempotent; already migrated/provisioned)
 *   - 4xx -> rejected (bad genesis / anchor mismatch surfaced by univocity)
 *   - else -> unavailable (transient/unreachable; treat as 502/503)
 *
 * See plan-0029 (canopy) / plan-0008 (arbor).
 */

/** Configuration for reaching the univocity genesis endpoint. */
export interface UnivocityGenesisClient {
  /** Base service URL, e.g. `https://univocity.example`. */
  serviceUrl: string;
  /** Bearer token authorizing canopy -> univocity calls. */
  token: string;
}

export type UnivocityGenesisResult =
  | { kind: "created" }
  | { kind: "exists" }
  | { kind: "rejected"; status: number; detail: string }
  | { kind: "unavailable"; detail: string };

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function readDetail(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 512);
  } catch {
    return "";
  }
}

/**
 * Forwards the canonical genesis CBOR for forest root `R` to univocity.
 *
 * @param client univocity service URL + bearer token.
 * @param rootStorageSeg canonical dashed UUID of forest root `R`.
 * @param genesisCbor canonical v1 genesis document bytes.
 */
export async function postGenesisToUnivocity(
  client: UnivocityGenesisClient,
  rootStorageSeg: string,
  genesisCbor: Uint8Array,
): Promise<UnivocityGenesisResult> {
  let res: Response;
  try {
    res = await fetch(
      joinUrl(client.serviceUrl, `/api/forest/${rootStorageSeg}/genesis`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/cbor",
          Authorization: `Bearer ${client.token}`,
        },
        body: genesisCbor,
      },
    );
  } catch (e) {
    return {
      kind: "unavailable",
      detail:
        e instanceof Error
          ? `univocity genesis unreachable: ${e.message}`
          : "univocity genesis unreachable",
    };
  }

  if (res.status === 201) return { kind: "created" };
  if (res.status === 409) return { kind: "exists" };
  if (res.status >= 400 && res.status < 500) {
    return {
      kind: "rejected",
      status: res.status,
      detail: await readDetail(res),
    };
  }
  return {
    kind: "unavailable",
    detail: `univocity genesis returned ${res.status}: ${await readDetail(res)}`,
  };
}
