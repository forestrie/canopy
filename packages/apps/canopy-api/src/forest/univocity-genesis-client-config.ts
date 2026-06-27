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
