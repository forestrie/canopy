import { decode as decodeCbor, encode as encodeCbor } from "cbor-x";

export function encodeToCbor(value: unknown): Uint8Array {
  return encodeCbor(value) as Uint8Array;
}

export async function parseCborBody<T = unknown>(request: Request): Promise<T> {
  const arrayBuffer = await request.arrayBuffer();
  return decodeCbor(new Uint8Array(arrayBuffer)) as T;
}


