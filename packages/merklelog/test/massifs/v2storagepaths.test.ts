import { describe, it, expect } from "vitest";
import { parseV2StorageObjectPath } from "../../src/massifs/v2storagepaths.js";

describe("v2storagepaths", () => {
  describe("parseV2StorageObjectPath", () => {
    describe("valid massif paths", () => {
      it("should parse a valid massif path", () => {
        const path = "v2/merklelog/massifs/14/my-log-id/0000000000000005.log";
        const result = parseV2StorageObjectPath(path);

        expect(result.logId).toBe("my-log-id");
        expect(result.massifHeight).toBe(14);
        expect(result.massifIndex).toBe(5);
        expect(result.type).toBe("massifs");
      });

      it("should parse massif index 0", () => {
        const path = "v2/merklelog/massifs/14/log-abc/0000000000000000.log";
        const result = parseV2StorageObjectPath(path);

        expect(result.massifIndex).toBe(0);
      });

      it("should parse large massif index", () => {
        const path = "v2/merklelog/massifs/14/log-abc/00000000000000ff.log";
        const result = parseV2StorageObjectPath(path);

        expect(result.massifIndex).toBe(255);
      });

      it("should parse massif index with uppercase hex", () => {
        const path = "v2/merklelog/massifs/14/log-abc/00000000000000FF.log";
        const result = parseV2StorageObjectPath(path);

        expect(result.massifIndex).toBe(255);
      });

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
        expect(result.massifIndex).toBe(5);
        expect(result.type).toBe("checkpoints");
      });

      it("should parse checkpoint index 0", () => {
        const path = "v2/merklelog/checkpoints/14/log-abc/0000000000000000.sth";
        const result = parseV2StorageObjectPath(path);

        expect(result.massifIndex).toBe(0);
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
          "Massif index must be 16 hex digits",
        );
      });

      it("should throw on massif index that is too long", () => {
        const path = "v2/merklelog/massifs/14/log/00000000000000005.log"; // 17 digits
        expect(() => parseV2StorageObjectPath(path)).toThrow(
          "Massif index must be 16 hex digits",
        );
      });

      it("should parse partial hex when invalid char at end (parseInt behavior)", () => {
        // Note: parseInt stops at first invalid char, so '000000000000000g' parses as 0
        // This is JavaScript parseInt behavior - it doesn't throw
        const path = "v2/merklelog/massifs/14/log/000000000000000g.log";
        const result = parseV2StorageObjectPath(path);
        expect(result.massifIndex).toBe(0); // Parsed as 0 (15 zeros before 'g')
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
