import { describe, it, expect } from "vitest";
import { Massif } from "../../src/massifs/massif.js";
import { LogFormat } from "../../src/massifs/types.js";

describe("Massif", () => {
  // Create a test buffer with known values
  function createTestBuffer(): Uint8Array {
    const buffer = new Uint8Array(256); // Start header size

    // Write test values using DataView for big-endian
    const view = new DataView(buffer.buffer);

    // Reserved (bytes 0-7): 0x0000000000000001
    view.setBigUint64(0, 1n, false);

    // LastID (bytes 8-15): 0x1234567890ABCDEF
    view.setBigUint64(8, 0x1234567890abcdefn, false);

    // Version (bytes 21-22): 0x0001
    view.setUint16(21, 1, false);

    // CommitmentEpoch (bytes 23-26): 0x00000042
    view.setUint32(23, 0x42, false);

    // MassifHeight (byte 27): 0x03
    buffer[27] = 3;

    // MassifIndex (bytes 28-31): 0x00000005
    view.setUint32(28, 5, false);

    return buffer;
  }

  describe("constructor", () => {
    it("should accept ArrayBuffer", () => {
      const buffer = new ArrayBuffer(256);
      const massif = new Massif(buffer);
      expect(massif).toBeInstanceOf(Massif);
    });

    it("should accept Uint8Array", () => {
      const buffer = new Uint8Array(256);
      const massif = new Massif(buffer);
      expect(massif).toBeInstanceOf(Massif);
    });
  });

  describe("dynamic properties", () => {
    it("should read reserved field", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      expect(massif.reserved).toBe(1n);
    });

    it("should read lastID field", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      expect(massif.lastID).toBe(0x1234567890abcdefn);
    });

    it("should read version field", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      expect(massif.version).toBe(1);
    });

    it("should read commitmentEpoch field", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      expect(massif.commitmentEpoch).toBe(0x42);
    });

    it("should read massifHeight field", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      expect(massif.massifHeight).toBe(3);
    });

    it("should read massifIndex field", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      expect(massif.massifIndex).toBe(5);
    });
  });

  describe("getStart", () => {
    it("should return complete MassifStart with computed fields", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      const start = massif.getStart();

      expect(start.reserved).toBe(1n);
      expect(start.lastID).toBe(0x1234567890abcdefn);
      expect(start.version).toBe(1);
      expect(start.commitmentEpoch).toBe(0x42);
      expect(start.massifHeight).toBe(3);
      expect(start.massifIndex).toBe(5);
      expect(typeof start.firstIndex).toBe("bigint");
      expect(typeof start.peakStackLen).toBe("bigint");
      expect(start.firstIndex).toBeGreaterThan(0n);
      expect(start.peakStackLen).toBeGreaterThanOrEqual(0n);
    });
  });

  describe("fieldref", () => {
    it("should return field at index 0", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      const field = massif.fieldref(0);

      expect(field.length).toBe(LogFormat.ValueBytes);
      expect(field[0]).toBe(0);
      expect(field[7]).toBe(1); // Reserved field has 1 at byte 7
    });

    it("should return field at index 1", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      const field = massif.fieldref(1);

      expect(field.length).toBe(LogFormat.ValueBytes);
      // Field 1 starts at offset 32, which is after our test data
      expect(field).toBeInstanceOf(Uint8Array);
    });

    it("should accept BigInt index", () => {
      const buffer = createTestBuffer();
      const massif = new Massif(buffer);
      const field = massif.fieldref(0n);

      expect(field.length).toBe(LogFormat.ValueBytes);
    });

    it("should return different views for different indices", () => {
      const buffer = new Uint8Array(128); // 4 fields
      buffer[0] = 0xaa; // Field 0, byte 0
      buffer[32] = 0xbb; // Field 1, byte 0

      const massif = new Massif(buffer);
      const field0 = massif.fieldref(0);
      const field1 = massif.fieldref(1);

      expect(field0[0]).toBe(0xaa);
      expect(field1[0]).toBe(0xbb);
    });
  });
});
