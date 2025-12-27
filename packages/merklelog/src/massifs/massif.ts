import type { MassifStart } from "./massifstart.js";
import { MassifStartFmt } from "./massifstart.js";
import { LogFormat } from "./logformat.js";
import { massifFirstLeaf, leafMinusSpurSum } from "../mmr/index.js";

/**
 * Massif - Efficient buffer-based access to massif data
 *
 * Provides efficient access to massif start data based on a view of an
 * in-memory buffer which holds the data. All operations work directly with
 * the buffer without copying.
 */
export class Massif {
  private readonly buffer: Uint8Array;

  /**
   * Creates a new Massif instance from buffer data
   * @param data - The massif data as ArrayBuffer, Uint8Array, or Buffer
   */
  constructor(
    data:
      | ArrayBuffer
      | Uint8Array
      | Buffer
      | { buffer: ArrayBuffer; byteOffset: number; byteLength: number },
  ) {
    if (data instanceof ArrayBuffer) {
      this.buffer = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      this.buffer = data;
    } else if (
      "buffer" in data &&
      "byteOffset" in data &&
      "byteLength" in data
    ) {
      // Node.js Buffer or similar
      this.buffer = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
    } else {
      throw new Error("Unsupported buffer type");
    }
  }

  /**
   * Returns a MassifStart instance populated by reading directly from the buffer
   *
   * Computes firstIndex using massif height and index (calls MMR function)
   * Computes peakStackLen using massif index (calls MMR function)
   */
  getStart(): MassifStart {
    const massifHeight = this.massifHeight;
    const massifIndex = this.massifIndex;

    // Compute firstIndex using massif height and index
    const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

    // Compute peakStackLen using massif index
    const peakStackLen = leafMinusSpurSum(BigInt(massifIndex));

    return {
      reserved: this.reserved,
      lastID: this.lastID,
      version: this.version,
      commitmentEpoch: this.commitmentEpoch,
      massifHeight,
      massifIndex,
      firstIndex,
      peakStackLen,
    };
  }

  /**
   * Returns a buffer view of the corresponding field at zero-based index
   *
   * Each field is 32 bytes (LogFormat.ValueBytes). Zero-based indexing, without regard
   * to peakstack or trieindex structure.
   *
   * @param index - Zero-based field index (Number or BigInt)
   * @param count - Number of consecutive fields to include in the view (defaults to 1)
   * @returns Uint8Array view of the field(s) (32 bytes per field)
   */
  fieldref(index: number | bigint, count: number = 1): Uint8Array {
    const idx = typeof index === "bigint" ? Number(index) : index;
    const offset = idx * LogFormat.ValueBytes;
    return this.buffer.slice(offset, offset + count * LogFormat.ValueBytes);
  }

  /**
   * Reads bytes from the buffer at the specified offset
   *
   * Returns a view of the buffer without copying. Efficient for reading
   * arbitrary byte ranges that may span multiple 32-byte fields.
   *
   * @param offset - Byte offset into the buffer
   * @param length - Number of bytes to read
   * @returns Uint8Array view of the requested bytes
   */
  readBytes(offset: number, length: number): Uint8Array {
    return this.buffer.slice(offset, offset + length);
  }

  /**
   * Reads a big-endian uint64 from the buffer
   */
  private readUint64BE(offset: number): bigint {
    const view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset + offset,
      8,
    );
    return view.getBigUint64(0, false); // false = big-endian
  }

  /**
   * Reads a big-endian uint32 from the buffer
   */
  private readUint32BE(offset: number): number {
    const view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset + offset,
      4,
    );
    return view.getUint32(0, false); // false = big-endian
  }

  /**
   * Reads a big-endian uint16 from the buffer
   */
  private readUint16BE(offset: number): number {
    const view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset + offset,
      2,
    );
    return view.getUint16(0, false); // false = big-endian
  }

  /**
   * Reserved field (bytes 0-7)
   */
  get reserved(): bigint {
    return this.readUint64BE(0);
  }

  /**
   * Last ID timestamp (bytes 8-15)
   */
  get lastID(): bigint {
    return this.readUint64BE(MassifStartFmt.LastIdFirstByte);
  }

  /**
   * Version (bytes 21-22)
   */
  get version(): number {
    return this.readUint16BE(MassifStartFmt.VersionFirstByte);
  }

  /**
   * Commitment epoch (bytes 23-26)
   */
  get commitmentEpoch(): number {
    return this.readUint32BE(MassifStartFmt.EpochFirstByte);
  }

  /**
   * Massif height (byte 27)
   */
  get massifHeight(): number {
    return this.buffer[MassifStartFmt.MassifHeightFirstByte];
  }

  /**
   * Massif index (bytes 28-31)
   */
  get massifIndex(): number {
    return this.readUint32BE(MassifStartFmt.MassifFirstByte);
  }
}
