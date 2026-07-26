import { describe, expect, it } from "vitest";
import {
  UnivocityInstanceIdError,
  chainBindingFromUnivocityInstanceId,
  isUnivocityInstanceId,
  parseUnivocityInstanceId,
  tryUnivocityInstanceIdFromChainBinding,
  univocityInstanceIdFromAddressBytes,
  univocityInstanceIdFromChainBinding,
} from "../src/index.js";

const ADDR = "75be7950f26fe7f15336a10b33a8d8134fadb787";
const CANONICAL = `eip155:84532:0x${ADDR}`;

describe("parseUnivocityInstanceId (reject, never repair)", () => {
  it("accepts the exact canonical form", () => {
    expect(parseUnivocityInstanceId(CANONICAL)).toBe(CANONICAL);
    expect(isUnivocityInstanceId(CANONICAL)).toBe(true);
  });

  it.each([
    ["retired bespoke form", `84532:${ADDR}`],
    ["bespoke with 0x", `84532:0x${ADDR}`],
    ["missing 0x prefix", `eip155:84532:${ADDR}`],
    [
      "checksum-cased address",
      `eip155:84532:0x75bE7950F26fe7F15336a10b33A8D8134faDb787`,
    ],
    ["uppercase namespace", `EIP155:84532:0x${ADDR}`],
    ["wrong namespace", `cosmos:84532:0x${ADDR}`],
    ["leading-zero chain id", `eip155:084532:0x${ADDR}`],
    ["zero chain id", `eip155:0:0x${ADDR}`],
    ["address too short", `eip155:84532:0x${ADDR.slice(1)}`],
    ["address too long", `eip155:84532:0x${ADDR}0`],
    ["surrounding whitespace", ` ${CANONICAL}`],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(() => parseUnivocityInstanceId(value)).toThrow(
      UnivocityInstanceIdError,
    );
    expect(isUnivocityInstanceId(value)).toBe(false);
  });
});

describe("univocityInstanceIdFromChainBinding (trusted construction)", () => {
  it("renders a stored binding canonically", () => {
    expect(
      univocityInstanceIdFromChainBinding({
        chainId: "84532",
        univocityAddr: ADDR,
      }),
    ).toBe(CANONICAL);
  });

  it("normalises case and an optional 0x prefix", () => {
    expect(
      univocityInstanceIdFromChainBinding({
        chainId: "84532",
        univocityAddr: `0x${ADDR.toUpperCase()}`,
      }),
    ).toBe(CANONICAL);
  });

  it.each([
    ["CAIP-2 chain id", { chainId: "eip155:84532", univocityAddr: ADDR }],
    ["empty chain id", { chainId: "", univocityAddr: ADDR }],
    ["leading-zero chain id", { chainId: "084532", univocityAddr: ADDR }],
    ["short address", { chainId: "84532", univocityAddr: ADDR.slice(1) }],
    ["empty address", { chainId: "84532", univocityAddr: "" }],
  ])("throws on %s", (_label, binding) => {
    expect(() => univocityInstanceIdFromChainBinding(binding)).toThrow(
      UnivocityInstanceIdError,
    );
    expect(tryUnivocityInstanceIdFromChainBinding(binding)).toBeUndefined();
  });
});

describe("univocityInstanceIdFromAddressBytes", () => {
  it("renders 20 bytes canonically", () => {
    const bytes = new Uint8Array(
      ADDR.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
    );
    expect(univocityInstanceIdFromAddressBytes("84532", bytes)).toBe(CANONICAL);
  });

  it("rejects non-20-byte addresses", () => {
    expect(() =>
      univocityInstanceIdFromAddressBytes("84532", new Uint8Array(19)),
    ).toThrow(UnivocityInstanceIdError);
  });
});

describe("chainBindingFromUnivocityInstanceId (round trip)", () => {
  it("recovers the stored-form binding", () => {
    expect(chainBindingFromUnivocityInstanceId(CANONICAL)).toEqual({
      chainId: "84532",
      univocityAddr: ADDR,
    });
  });

  it("round-trips through construction", () => {
    const binding = chainBindingFromUnivocityInstanceId(CANONICAL);
    expect(univocityInstanceIdFromChainBinding(binding)).toBe(CANONICAL);
  });

  it("rejects non-canonical input", () => {
    expect(() => chainBindingFromUnivocityInstanceId(`84532:${ADDR}`)).toThrow(
      UnivocityInstanceIdError,
    );
  });
});
