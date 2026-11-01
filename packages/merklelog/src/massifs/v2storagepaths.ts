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

const MASSIF_OBJECT_INDEX_RE = /^[0-9]{16}$/;
const MASSIF_HEIGHT_RE = /^[0-9]+$/;
const MAX_MASSIF_OBJECT_INDEX = 10n ** BigInt(MASSIF_OBJECT_INDEX_DIGITS) - 1n;

/**
 * Build the massif `.log` object key for a log.
 */
export function v2MassifObjectKey(
  massifHeight: number,
  logId: string,
  massifIndex: bigint | number,
): string {
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
  return `v2/merklelog/checkpoints/${massifHeight}/${logId}/${formatMassifObjectIndex(massifIndex)}.sth`;
}

/**
 * Format a massif index as the 16-digit decimal key segment (Go `%016d`).
 *
 * @throws Error if the index is negative, not an integer, not a safe integer
 *   (number input), or does not fit in 16 decimal digits.
 */
export function formatMassifObjectIndex(massifIndex: bigint | number): string {
  if (typeof massifIndex === "number" && !Number.isSafeInteger(massifIndex)) {
    throw new Error(`Massif index must be a safe integer, got ${massifIndex}`);
  }
  const index = BigInt(massifIndex);
  if (index < 0n || index > MAX_MASSIF_OBJECT_INDEX) {
    throw new Error(
      `Massif index must be 0..${MAX_MASSIF_OBJECT_INDEX}, got ${index}`,
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

  if (parts.length < 6 || parts[0] !== "v2" || parts[1] !== "merklelog")
    throw new Error(`Unrecognized path format: ${path}`);

  const typePart = parts[2]; // "massifs" or "checkpoints"
  const massifHeightStr = parts[3];
  const logId = parts[4];
  const filename = parts[5];

  const expectedExt = typePart === "massifs" ? ".log" : ".sth";
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

  if (!MASSIF_HEIGHT_RE.test(massifHeightStr)) {
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
