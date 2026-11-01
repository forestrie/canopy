import { describe, it, expect } from "vitest";
import {
  formatMassifObjectIndex,
  parseV2StorageObjectPath,
  v2CheckpointObjectKey,
  v2MassifObjectKey,
} from "../../src/massifs/v2storagepaths.js";

/**
 * Shared radix vectors. The Go writer (go-merklelog
 * massifs/storage/const.go `%016d.log`) names objects with a zero-padded
 * 16-digit DECIMAL index; indices >= 10 are where a hex reader diverges.
 */
const RADIX_VECTORS: ReadonlyArray<[bigint, string]> = [
  [0n, "0000000000000000"],
  [9n, "0000000000000009"],
  [10n, "0000000000000010"],
  [16n, "0000000000000016"],
  [255n, "0000000000000255"],
  [4294967295n, "0000004294967295"], // Go uint32 max
  [9999999999999999n, "9999999999999999"],
];

describe("v2storagepaths", () => {
  describe("formatMassifObjectIndex", () => {
    it.each(RADIX_VECTORS)("formats %s as %s", (index, segment) => {
      expect(formatMassifObjectIndex(index)).toBe(segment);
    });

    it("accepts a safe-integer number", () => {
      expect(formatMassifObjectIndex(10)).toBe("0000000000000010");
    });

    it.each([
      ["negative", -1n],
      ["17 digits", 10000000000000000n],
      ["non-integer number", 1.5],
      ["unsafe number", Number.MAX_SAFE_INTEGER + 1],
    ])("rejects %s", (_label, index) => {
      expect(() => formatMassifObjectIndex(index)).toThrow();
    });
  });

  describe("object keys", () => {
    it("builds the massif key with a decimal index", () => {
      expect(v2MassifObjectKey(14, "log-abc", 10n)).toBe(
        "v2/merklelog/massifs/14/log-abc/0000000000000010.log",
      );
    });

    it("builds the checkpoint key with a decimal index", () => {
      expect(v2CheckpointObjectKey(14, "log-abc", 10n)).toBe(
        "v2/merklelog/checkpoints/14/log-abc/0000000000000010.sth",
      );
    });

    it.each(RADIX_VECTORS)("round-trips index %s", (index) => {
      expect(
        parseV2StorageObjectPath(v2MassifObjectKey(14, "l", index)).massifIndex,
      ).toBe(index);
      expect(
        parseV2StorageObjectPath(v2CheckpointObjectKey(14, "l", index))
          .massifIndex,
      ).toBe(index);
    });
  });

  describe("parseV2StorageObjectPath", () => {
    describe("valid massif paths", () => {
      it("should parse a valid massif path", () => {
        const path = "v2/merklelog/massifs/14/my-log-id/0000000000000005.log";
        const result = parseV2StorageObjectPath(path);

        expect(result.logId).toBe("my-log-id");
        expect(result.massifHeight).toBe(14);
        expect(result.massifIndex).toBe(5n);
        expect(result.type).toBe("massifs");
      });

      it("should parse massif index 0", () => {
        const path = "v2/merklelog/massifs/14/log-abc/0000000000000000.log";
        const result = parseV2StorageObjectPath(path);

        expect(result.massifIndex).toBe(0n);
      });

      it.each(RADIX_VECTORS)(
        "should parse index %s from segment %s as decimal",
        (index, segment) => {
          const path = `v2/merklelog/massifs/14/log-abc/${segment}.log`;
          expect(parseV2StorageObjectPath(path).massifIndex).toBe(index);
        },
      );

      it("should parse different massif heights", () => {
        const path1 = "v2/merklelog/massifs/1/log/0000000000000000.log";
        const path14 = "v2/merklelog/massifs/14/log/0000000000000000.log";
        const path20 = "v2/merklelog/massifs/20/log/0000000000000000.log";

        expect(parseV2StorageObjectPath(path1).massifHeight).toBe(1);
        expect(parseV2StorageObjectPath(path14).massifHeight).toBe(14);
        expect(parseV2StorageObjectPath(path20).massifHeight).toBe(20);
      });

      it("should preserve log ID with special characters", () => {
        const path =
          "v2/merklelog/massifs/14/log-with-dashes_and_underscores/0000000000000000.log";
        const result = parseV2StorageObjectPath(path);

        expect(result.logId).toBe("log-with-dashes_and_underscores");
      });
    });

    describe("valid checkpoint paths", () => {
      it("should parse a valid checkpoint path", () => {
        const path =
          "v2/merklelog/checkpoints/14/my-log-id/0000000000000005.sth";
        const result = parseV2StorageObjectPath(path);

        expect(result.logId).toBe("my-log-id");
        expect(result.massifHeight).toBe(14);
        expect(result.massifIndex).toBe(5n);
        expect(result.type).toBe("checkpoints");
      });

      it("should parse checkpoint index 0", () => {
        const path = "v2/merklelog/checkpoints/14/log-abc/0000000000000000.sth";
        const result = parseV2StorageObjectPath(path);

        expect(result.massifIndex).toBe(0n);
        expect(result.type).toBe("checkpoints");
      });
    });

    describe("invalid paths", () => {
      it("should throw on path without v2 prefix", () => {
        const path = "v1/merklelog/massifs/14/log/0000000000000000.log";
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Unrecognized path format",
        );
      });

      it("should throw on path without merklelog", () => {
        const path = "v2/other/massifs/14/log/0000000000000000.log";
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Unrecognized path format",
        );
      });

      it("should throw on path with too few parts", () => {
        const path = "v2/merklelog/massifs/14/log";
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Unrecognized path format",
        );
      });

      it("should throw on massif path with wrong extension", () => {
        const path = "v2/merklelog/massifs/14/log/0000000000000000.sth";
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Expected .log extension",
        );
      });

      it("should throw on checkpoint path with wrong extension", () => {
        const path = "v2/merklelog/checkpoints/14/log/0000000000000000.log";
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Expected .sth extension",
        );
      });

      it("should throw on massif index with wrong length", () => {
        const path = "v2/merklelog/massifs/14/log/000000000000005.log"; // 15 digits
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Massif index must be 16 decimal digits",
        );
      });

      it("should throw on massif index that is too long", () => {
        const path = "v2/merklelog/massifs/14/log/00000000000000005.log"; // 17 digits
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Massif index must be 16 decimal digits",
        );
      });

      it.each([
        ["trailing non-digit", "000000000000000g"],
        ["hex digits", "00000000000000ff"],
        ["uppercase hex", "00000000000000FF"],
        ["sign", "+000000000000010"],
        ["whitespace", " 000000000000010"],
      ])("should throw on massif index with %s", (_label, segment) => {
        const path = `v2/merklelog/massifs/14/log/${segment}.log`;
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Massif index must be 16 decimal digits",
        );
      });

      it("should throw on massif height with trailing junk", () => {
        const path = "v2/merklelog/massifs/14x/log/0000000000000000.log";
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Failed to parse massif height",
        );
      });

      it("should throw on non-numeric massif height", () => {
        const path = "v2/merklelog/massifs/abc/log/0000000000000000.log";
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Failed to parse massif height",
        );
      });

      it("should throw on empty path", () => {
        expect(() => parseV2StorageObjectPath("")).toThrow(
          "Unrecognized path format",
        );
      });
    });
  });
});
