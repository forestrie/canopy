/**
 * Parse an R2 object path to extract log ID, massif height, and massif index.
 *
 * - v2/merklelog/massifs/{massifHeight}/{logId}/{massifIndex}.log
 * - v2/merklelog/checkpoints/{massifHeight}/{logId}/{massifIndex}.sth
 *
 * @param path - The object path path from the R2 notification
 * @returns Parsed components including logId, massifHeight, and massifIndex
 * @throws Error if the path doesn't match expected format or if parsing fails
 */
export function parseV2StorageObjectPath(path: string) {
  const parts = path.split("/");

  if (parts.length < 6 || parts[0] !== "v2" || parts[1] !== "merklelog")
    throw new Error(`Unrecognized path format: ${path}`);

  // Check for new v2 format: v2/merklelog/massifs/{massifHeight}/{logId}/{index}.log
  // or v2/merklelog/checkpoints/{massifHeight}/{logId}/{index}.sth
  const typePart = parts[2]; // "massifs" or "checkpoints"
  const massifHeightStr = parts[3];
  const logId = parts[4];
  const filename = parts[5];

  // Validate extension
  const expectedExt = typePart === "massifs" ? ".log" : ".sth";
  if (!filename.endsWith(expectedExt)) {
    throw new Error(
      `Expected ${expectedExt} extension for ${typePart}, got: ${filename}`,
    );
  }

  // Parse massif index (hex, 16 digits)
  const massifIndexStr = filename.slice(0, -expectedExt.length);
  if (massifIndexStr.length !== 16) {
    throw new Error(
      `Massif index must be 16 hex digits, got ${massifIndexStr.length}: ${massifIndexStr}`,
    );
  }

  const massifIndex = Number.parseInt(massifIndexStr, 16);
  if (!Number.isFinite(massifIndex)) {
    throw new Error(
      `Failed to parse massif index as hex number: ${massifIndexStr}`,
    );
  }

  // Parse massifHeight
  const massifHeight = Number.parseInt(massifHeightStr, 10);
  if (!Number.isFinite(massifHeight)) {
    throw new Error(
      `Failed to parse massif height as number: ${massifHeightStr}`,
    );
  }

  return {
    logId,
    massifHeight,
    massifIndex,
    type: typePart,
  };
}
