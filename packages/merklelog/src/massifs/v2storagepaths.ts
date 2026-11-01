/**
 * Merklelog v2 R2 object layout:
 *
 * - v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
 * - v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
 *
 * `{massifIndex}` is a zero-padded, 16-digit DECIMAL integer. The Go writer
 * owns this convention: go-merklelog
 * [massifs/storage/const.go](https://github.com/forestrie/go-merklelog/blob/main/massifs/storage/const.go)
 * (`V1MMRBlobNameFmt = "%016d.log"`, `V1MMRSignedTreeHeadBlobNameFmt =
 * "%016d.sth"`) and its reader
 * [objectindexfrompath.go](https://github.com/forestrie/go-merklelog/blob/main/massifs/storage/objectindexfrompath.go)
 * (`strconv.Atoi`). Every TypeScript reader and writer of these keys goes
 * through the functions here (FOR-621: an earlier reader parsed hex, which
 * agrees with the writer only for indices 0-9).
 */

/** Width of the massif index segment in an object key. */
export const MASSIF_OBJECT_INDEX_DIGITS = 16;

/**
 * Largest massif index the Go side can represent. go-merklelog
 * `FmtMassifPath(prefix, massifIndex uint32)` and arbor's publisher
 * (`strconv.ParseUint(base, 10, 32)`) use `uint32`; a larger index would be
 * silently truncated by `ObjectIndexFromPath`, so it is rejected here.
 */
export const MAX_MASSIF_INDEX = 0xffffffffn;

/**
 * Massif height bounds. Go writes height as `%d` of a `uint8` and arbor's
 * publisher `ParseCheckpointKey` rejects 0, so valid heights are 1..255 with
 * no leading zeros.
 */
const MIN_MASSIF_HEIGHT = 1;
const MAX_MASSIF_HEIGHT = 255;

const MASSIF_OBJECT_INDEX_RE = /^[0-9]{16}$/;
const MASSIF_HEIGHT_RE = /^[1-9][0-9]{0,2}$/;
const OBJECT_EXTENSIONS: Readonly<Record<string, string>> = {
  massifs: ".log",
  checkpoints: ".sth",
};

/**
 * Build the massif `.log` object key for a log.
 */
export function v2MassifObjectKey(
  massifHeight: number,
  logId: string,
  massifIndex: bigint | number,
): string {
  assertKeyHeightAndLogId(massifHeight, logId);
  return `v2/merklelog/massifs/${massifHeight}/${logId}/${formatMassifObjectIndex(massifIndex)}.log`;
}

/**
 * Build the signed checkpoint `.sth` object key for a log.
 */
export function v2CheckpointObjectKey(
  massifHeight: number,
  logId: string,
  massifIndex: bigint | number,
): string {
  assertKeyHeightAndLogId(massifHeight, logId);
  return `v2/merklelog/checkpoints/${massifHeight}/${logId}/${formatMassifObjectIndex(massifIndex)}.sth`;
}

/**
 * Reject a massif height or log id that would build a key Go cannot read:
 * height outside 1..255 or non-integer, or a log id that is empty or would
 * add path segments.
 */
function assertKeyHeightAndLogId(massifHeight: number, logId: string): void {
  if (
    !Number.isInteger(massifHeight) ||
    massifHeight < MIN_MASSIF_HEIGHT ||
    massifHeight > MAX_MASSIF_HEIGHT
  ) {
    throw new Error(
      `Massif height must be an integer ${MIN_MASSIF_HEIGHT}..${MAX_MASSIF_HEIGHT}, got ${massifHeight}`,
    );
  }
  if (logId.length === 0 || logId.includes("/")) {
    throw new Error(
      `Log id must be a non-empty path segment, got: ${JSON.stringify(logId)}`,
    );
  }
}

/**
 * Format a massif index as the 16-digit decimal key segment (Go `%016d`).
 *
 * @throws Error if the index is negative, not an integer, not a safe integer
 *   (number input), or exceeds {@link MAX_MASSIF_INDEX}.
 */
export function formatMassifObjectIndex(massifIndex: bigint | number): string {
  if (typeof massifIndex === "number" && !Number.isSafeInteger(massifIndex)) {
    throw new Error(`Massif index must be a safe integer, got ${massifIndex}`);
  }
  const index = BigInt(massifIndex);
  if (index < 0n || index > MAX_MASSIF_INDEX) {
    throw new Error(
      `Massif index must be 0..${MAX_MASSIF_INDEX}, got ${index}`,
    );
  }
  return index.toString(10).padStart(MASSIF_OBJECT_INDEX_DIGITS, "0");
}

/**
 * Parse an R2 object path to extract log ID, massif height, and massif index.
 *
 * @param path - The object path from the R2 notification
 * @returns Parsed components including logId, massifHeight, and massifIndex
 * @throws Error if the path doesn't match expected format or if parsing fails
 */
export function parseV2StorageObjectPath(path: string) {
  const parts = path.split("/");

  if (parts.length !== 6 || parts[0] !== "v2" || parts[1] !== "merklelog")
    throw new Error(`Unrecognized path format: ${path}`);

  const typePart = parts[2];
  const massifHeightStr = parts[3];
  const logId = parts[4];
  const filename = parts[5];

  const expectedExt = Object.hasOwn(OBJECT_EXTENSIONS, typePart)
    ? OBJECT_EXTENSIONS[typePart]
    : undefined;
  if (expectedExt === undefined) {
    throw new Error(
      `Object type must be massifs or checkpoints, got: ${typePart}`,
    );
  }
  if (logId.length === 0) {
    throw new Error(`Log id segment is empty: ${path}`);
  }
  if (!filename.endsWith(expectedExt)) {
    throw new Error(
      `Expected ${expectedExt} extension for ${typePart}, got: ${filename}`,
    );
  }

  const massifIndexStr = filename.slice(0, -expectedExt.length);
  if (!MASSIF_OBJECT_INDEX_RE.test(massifIndexStr)) {
    throw new Error(
      `Massif index must be 16 decimal digits, got: ${massifIndexStr}`,
    );
  }
  const massifIndex = BigInt(massifIndexStr);
  if (massifIndex > MAX_MASSIF_INDEX) {
    throw new Error(
      `Massif index must be 0..${MAX_MASSIF_INDEX}, got ${massifIndex}`,
    );
  }

  if (
    !MASSIF_HEIGHT_RE.test(massifHeightStr) ||
    Number(massifHeightStr) > MAX_MASSIF_HEIGHT
  ) {
    throw new Error(
      `Failed to parse massif height as number: ${massifHeightStr}`,
    );
  }
  const massifHeight = Number(massifHeightStr);

  return {
    logId,
    massifHeight,
    massifIndex,
    type: typePart,
  };
}
