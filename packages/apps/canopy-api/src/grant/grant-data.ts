/**
 * Shapes that normalize to bytes for Solidity `PublishGrant.grantData` on-chain.
 * Anything encoded into the contract field should be representable here over time.
 */

/** ES256 P-256 public key as uncompressed x||y (64 bytes), e.g. bootstrap checkpoint signer. */
export interface GrantDataEs256Xy {
  readonly kind: "es256-xy";
  readonly xy: Uint8Array;
}

export type GrantData = Uint8Array | GrantDataEs256Xy;

/**
 * Bytes committed in the grant hash. Accepts raw bytes or a structured {@link GrantData} variant.
 */
export function grantDataToBytes(data: Uint8Array | GrantData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data.kind === "es256-xy") return data.xy;
  throw new Error("Unsupported GrantData variant");
}
