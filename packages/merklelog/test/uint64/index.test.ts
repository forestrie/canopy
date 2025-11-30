import { describe, it, expect } from "vitest";
import { Uint64 } from "../../src/uint64/index.js";

describe("Uint64", () => {
  describe("constructor", () => {
    it("should create from number", () => {
      const u = new Uint64(42);
      expect(u.toBigInt()).toBe(42n);
    });

    it("should create from bigint", () => {
      const u = new Uint64(12345678901234567890n);
      expect(u.toBigInt()).toBe(12345678901234567890n);
    });

    it("should create from string", () => {
      const u = new Uint64("999");
      expect(u.toBigInt()).toBe(999n);
    });

    it("should create from Uint64", () => {
      const u1 = new Uint64(42);
      const u2 = new Uint64(u1);
      expect(u2.toBigInt()).toBe(42n);
    });

    it("should wrap values exceeding 64 bits", () => {
      const large = BigInt("0xFFFFFFFFFFFFFFFF") + 1n; // 2^64
      const u = new Uint64(large);
      expect(u.toBigInt()).toBe(0n); // Wraps to 0
    });
  });

  describe("add", () => {
    it("should add two values", () => {
      const a = new Uint64(10);
      const b = new Uint64(20);
      const result = a.add(b);
      expect(result.toBigInt()).toBe(30n);
    });

    it("should handle overflow", () => {
      const max = new Uint64("0xFFFFFFFFFFFFFFFF"); // 2^64 - 1
      const one = new Uint64(1);
      const result = max.add(one);
      expect(result.toBigInt()).toBe(0n); // Wraps to 0
    });
  });

  describe("sub", () => {
    it("should subtract two values", () => {
      const a = new Uint64(30);
      const b = new Uint64(20);
      const result = a.sub(b);
      expect(result.toBigInt()).toBe(10n);
    });

    it("should handle underflow", () => {
      const zero = new Uint64(0);
      const one = new Uint64(1);
      const result = zero.sub(one);
      expect(result.toBigInt()).toBe(BigInt("0xFFFFFFFFFFFFFFFF")); // Wraps to max
    });
  });

  describe("shl", () => {
    it("should shift left", () => {
      const u = new Uint64(1);
      const result = u.shl(3);
      expect(result.toBigInt()).toBe(8n);
    });

    it("should handle large shifts", () => {
      const u = new Uint64(1);
      const result = u.shl(63);
      expect(result.toBigInt()).toBe(BigInt("0x8000000000000000"));
    });

    it("should throw on invalid shift amount", () => {
      const u = new Uint64(1);
      expect(() => u.shl(64)).toThrow();
      expect(() => u.shl(-1)).toThrow();
    });
  });

  describe("shr", () => {
    it("should shift right", () => {
      const u = new Uint64(8);
      const result = u.shr(3);
      expect(result.toBigInt()).toBe(1n);
    });

    it("should handle large shifts", () => {
      const u = new Uint64("0x8000000000000000");
      const result = u.shr(63);
      expect(result.toBigInt()).toBe(1n);
    });

    it("should throw on invalid shift amount", () => {
      const u = new Uint64(1);
      expect(() => u.shr(64)).toThrow();
      expect(() => u.shr(-1)).toThrow();
    });
  });

  describe("and", () => {
    it("should perform bitwise AND", () => {
      const a = new Uint64(0b1010);
      const b = new Uint64(0b1100);
      const result = a.and(b);
      expect(result.toBigInt()).toBe(0b1000n);
    });
  });

  describe("or", () => {
    it("should perform bitwise OR", () => {
      const a = new Uint64(0b1010);
      const b = new Uint64(0b1100);
      const result = a.or(b);
      expect(result.toBigInt()).toBe(0b1110n);
    });
  });

  describe("xor", () => {
    it("should perform bitwise XOR", () => {
      const a = new Uint64(0b1010);
      const b = new Uint64(0b1100);
      const result = a.xor(b);
      expect(result.toBigInt()).toBe(0b0110n);
    });
  });

  describe("not", () => {
    it("should perform bitwise complement", () => {
      const u = new Uint64(0b1010);
      const result = u.not();
      // ~0b1010 (as 64-bit) = 0xFFFFFFFFFFFFFFF5
      expect(result.toBigInt()).toBe(BigInt("0xFFFFFFFFFFFFFFF5"));
    });

    it("should complement zero to max", () => {
      const zero = new Uint64(0);
      const result = zero.not();
      expect(result.toBigInt()).toBe(BigInt("0xFFFFFFFFFFFFFFFF"));
    });
  });

  describe("mask", () => {
    it("should mask lower bits", () => {
      const u = new Uint64(0b11111111);
      const result = u.mask(4);
      expect(result.toBigInt()).toBe(0b1111n);
    });

    it("should mask all 64 bits", () => {
      const u = new Uint64("0xFFFFFFFFFFFFFFFF");
      const result = u.mask(64);
      expect(result.toBigInt()).toBe(BigInt("0xFFFFFFFFFFFFFFFF"));
    });

    it("should throw on invalid mask bits", () => {
      const u = new Uint64(1);
      expect(() => u.mask(65)).toThrow();
      expect(() => u.mask(-1)).toThrow();
    });
  });

  describe("toNumber", () => {
    it("should convert safe integers", () => {
      const u = new Uint64(42);
      expect(u.toNumber()).toBe(42);
    });

    it("should throw on unsafe integers", () => {
      const u = new Uint64(Number.MAX_SAFE_INTEGER + 1);
      expect(() => u.toNumber()).toThrow();
    });
  });

  describe("equals", () => {
    it("should compare equal values", () => {
      const a = new Uint64(42);
      const b = new Uint64(42);
      expect(a.equals(b)).toBe(true);
    });

    it("should compare unequal values", () => {
      const a = new Uint64(42);
      const b = new Uint64(43);
      expect(a.equals(b)).toBe(false);
    });
  });
});
