/**
 * Uint64 - A BigInt-based wrapper for 64-bit unsigned integer operations
 *
 * Provides arithmetic and bitwise operations for 64-bit unsigned integers,
 * ensuring all operations stay within the 64-bit range using BigInt.asUintN(64, value).
 */
export class Uint64 {
  private readonly value: bigint;

  /**
   * Creates a new Uint64 instance
   * @param value - The initial value as number, bigint, or string
   */
  constructor(value: number | bigint | string | Uint64) {
    if (value instanceof Uint64) {
      this.value = value.value;
    } else {
      const bigIntValue = typeof value === "bigint" ? value : BigInt(value);
      this.value = BigInt.asUintN(64, bigIntValue);
    }
  }

  /**
   * Addition with overflow handling (wraps around at 2^64)
   * @param other - The value to add
   * @returns New Uint64 instance with the result
   */
  add(other: Uint64): Uint64 {
    const result = this.value + other.value;
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Subtraction with underflow handling (wraps around at 0)
   * @param other - The value to subtract
   * @returns New Uint64 instance with the result
   */
  sub(other: Uint64): Uint64 {
    const result = this.value - other.value;
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Left shift
   * @param bits - Number of bits to shift left
   * @returns New Uint64 instance with the result
   */
  shl(bits: number): Uint64 {
    if (bits < 0 || bits > 63) {
      throw new Error("Shift amount must be between 0 and 63");
    }
    const result = this.value << BigInt(bits);
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Right shift (logical, zero-fill)
   * @param bits - Number of bits to shift right
   * @returns New Uint64 instance with the result
   */
  shr(bits: number): Uint64 {
    if (bits < 0 || bits > 63) {
      throw new Error("Shift amount must be between 0 and 63");
    }
    const result = this.value >> BigInt(bits);
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Bitwise AND
   * @param other - The value to AND with
   * @returns New Uint64 instance with the result
   */
  and(other: Uint64): Uint64 {
    const result = this.value & other.value;
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Bitwise OR
   * @param other - The value to OR with
   * @returns New Uint64 instance with the result
   */
  or(other: Uint64): Uint64 {
    const result = this.value | other.value;
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Bitwise XOR
   * @param other - The value to XOR with
   * @returns New Uint64 instance with the result
   */
  xor(other: Uint64): Uint64 {
    const result = this.value ^ other.value;
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Bitwise complement (one's complement)
   * @returns New Uint64 instance with the result
   */
  not(): Uint64 {
    // For unsigned 64-bit, complement is ~value masked to 64 bits
    const result = ~this.value;
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Mask lower bits (equivalent to value & ((1 << bits) - 1))
   * @param bits - Number of lower bits to keep
   * @returns New Uint64 instance with the result
   */
  mask(bits: number): Uint64 {
    if (bits < 0 || bits > 64) {
      throw new Error("Mask bits must be between 0 and 64");
    }
    if (bits === 64) {
      return new Uint64(this.value);
    }
    const maskValue = (BigInt(1) << BigInt(bits)) - BigInt(1);
    const result = this.value & maskValue;
    return new Uint64(BigInt.asUintN(64, result));
  }

  /**
   * Returns the value as a BigInt
   * @returns The 64-bit unsigned value as BigInt
   */
  toBigInt(): bigint {
    return this.value;
  }

  /**
   * Returns the value as a number (with range check)
   * @returns The value as number if it fits in Number.MAX_SAFE_INTEGER
   * @throws Error if value exceeds Number.MAX_SAFE_INTEGER
   */
  toNumber(): number {
    if (this.value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `Value ${this.value} exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER})`
      );
    }
    return Number(this.value);
  }

  /**
   * Returns the value as a string
   * @returns String representation of the value
   */
  toString(): string {
    return this.value.toString();
  }

  /**
   * Equality comparison
   * @param other - The value to compare with
   * @returns True if values are equal
   */
  equals(other: Uint64): boolean {
    return this.value === other.value;
  }
}

