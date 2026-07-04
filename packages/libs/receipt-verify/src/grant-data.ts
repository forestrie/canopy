export interface GrantDataEs256Xy {
  readonly kind: "es256-xy";
  readonly xy: Uint8Array;
}

export type GrantData = Uint8Array | GrantDataEs256Xy;

export function grantDataToBytes(data: Uint8Array | GrantData): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data.kind === "es256-xy") return data.xy;
  throw new Error("Unsupported GrantData variant");
}
