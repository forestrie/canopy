export type UnivocityGateResult =
  | { ok: true; univocityAddr: string }
  | { ok: false; status: number; detail: string };
