/** COSE algorithm identifiers (matches arbor univocity validBootstrapIdentity). */
export const COSE_ALG_ES256 = -7;
export const COSE_ALG_KS256 = -65799;

const SELECTOR_BOOTSTRAP_CONFIG = "0x198865fe";
const SELECTOR_ROOT_LOG_ID = "0x72b76e4d";

function strip0x(hex: string): string {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

function readInt256Word(hex: string, wordIndex: number): bigint {
  const start = wordIndex * 64;
  const word = hex.slice(start, start + 64);
  return BigInt(`0x${word}`);
}

function readSignedInt64FromWord(hex: string, wordIndex: number): number {
  let v = readInt256Word(hex, wordIndex) & 0xffff_ffff_ffff_ffffn;
  if (v >= 0x8000_0000_0000_0000n) {
    v -= 0x1_0000_0000_0000_0000n;
  }
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/** Decode bootstrapConfig() eth_call return (int64 alg, bytes key). */
export function decodeBootstrapConfigResult(resultHex: string): {
  alg: number;
  key: Uint8Array;
} | null {
  const hex = strip0x(resultHex);
  if (hex.length < 128) return null;
  const algNum = readSignedInt64FromWord(hex, 0);
  if (!Number.isFinite(algNum)) return null;
  const offset = Number(readInt256Word(hex, 1));
  if (offset % 32 !== 0) return null;
  const offsetWords = offset / 32;
  const lenStart = offsetWords * 64;
  if (lenStart + 64 > hex.length) return null;
  const keyLen = Number(readInt256Word(hex, offsetWords));
  if (!Number.isFinite(keyLen) || keyLen <= 0 || keyLen > 128) return null;
  const dataStart = lenStart + 64;
  const keyHex = hex.slice(dataStart, dataStart + keyLen * 2);
  if (keyHex.length !== keyLen * 2) return null;
  const key = new Uint8Array(keyLen);
  for (let i = 0; i < keyLen; i++) {
    key[i] = Number.parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  }
  return { alg: algNum, key };
}

export function validBootstrapIdentity(alg: number, key: Uint8Array): boolean {
  if (alg === COSE_ALG_ES256) return key.length === 64;
  if (alg === COSE_ALG_KS256) return key.length === 20;
  return false;
}

export function decodeRootLogIdResult(resultHex: string): Uint8Array | null {
  const hex = strip0x(resultHex);
  if (hex.length !== 64) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bootstrapConfigCallData(): string {
  return SELECTOR_BOOTSTRAP_CONFIG;
}

export function rootLogIdCallData(): string {
  return SELECTOR_ROOT_LOG_ID;
}

export async function probeUnivocityIdentity(
  rpcUrl: string,
  addressHex: string,
  rpcTimeoutMs: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const { ethCall } = await import("../rpc/eth-rpc.js");
  const to = `0x${addressHex}`;

  let bootResult: unknown;
  try {
    bootResult = await ethCall(rpcUrl, to, bootstrapConfigCallData(), {
      timeoutMs: rpcTimeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error
          ? `bootstrapConfig probe failed: ${error.message}`
          : "bootstrapConfig probe failed",
    };
  }
  if (typeof bootResult !== "string") {
    return { ok: false, detail: "bootstrapConfig returned invalid data" };
  }
  const boot = decodeBootstrapConfigResult(bootResult);
  if (!boot || !validBootstrapIdentity(boot.alg, boot.key)) {
    return { ok: false, detail: "Address is not a Univocity contract" };
  }

  let rootResult: unknown;
  try {
    rootResult = await ethCall(rpcUrl, to, rootLogIdCallData(), {
      timeoutMs: rpcTimeoutMs,
    });
  } catch (error) {
    return {
      ok: false,
      detail:
        error instanceof Error
          ? `rootLogId probe failed: ${error.message}`
          : "rootLogId probe failed",
    };
  }
  if (typeof rootResult !== "string" || !decodeRootLogIdResult(rootResult)) {
    return { ok: false, detail: "rootLogId probe returned invalid data" };
  }

  return { ok: true };
}
