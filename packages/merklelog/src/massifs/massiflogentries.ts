/**
 * MassifLogEntries calculation for v2 massif format
 */

import { LogFormat } from "./logformat.js";
import { peakStackEnd } from "./peakstackend.js";

/**
 * MassifLogEntries calculates the number of log entries (nodes) in a blob from
 * the length of the blob in bytes.
 *
 * It does this by accounting for the index data and other header data.
 * If you know the FirstIndex from the massif start header you can get the
 * overall mmr size by direct addition.
 *
 * Note: this function exists so we can compute the mmrSize from just the blob
 * store metadata: we store the FirstIndex on a blob tag, and the blob
 * metadata includes ContentLength. This means when we are checking if a root
 * seal covers the current log head, we don't need to fetch the log massif blob.
 *
 * @param dataLen - Total length of the massif blob in bytes
 * @param massifHeight - One-based massif height
 * @returns Number of log entries (nodes) in the blob
 * @throws Error if the data length is too short to contain the required headers
 */
export function massifLogEntries(
  dataLen: number,
  massifHeight: number,
): bigint {
  const stackEnd = peakStackEnd(massifHeight);

  if (BigInt(dataLen) < stackEnd) {
    throw new Error(
      `Massif data length ${dataLen} is too short. Minimum required: ${stackEnd} bytes`,
    );
  }

  const mmrByteCount = BigInt(dataLen) - stackEnd;
  return mmrByteCount / BigInt(LogFormat.ValueBytes);
}
