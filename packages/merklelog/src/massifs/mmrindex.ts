/**
 * MMR index calculation functions for massifs
 *
 * Functions for computing MMR indices from massif metadata.
 */

import { massifLogEntries } from "./logformat.js";
import { massifFirstLeaf } from "../mmr/index.js";

/**
 * Compute the last MMR index in a massif.
 *
 * @param massifHeight - Massif height (1-based, needs conversion to 0-based)
 * @param massifIndex - Massif index
 * @param blobSize - Size of the massif blob in bytes
 * @returns The last MMR index in the massif
 */
export function computeLastMMRIndex(
  massifHeight: number,
  massifIndex: number,
  blobSize: number,
): bigint {
  // Convert 1-based height to 0-based height index
  const heightIndex = massifHeight - 1;

  // Calculate number of log entries (nodes) in the blob
  const logEntries = massifLogEntries(blobSize, heightIndex);

  // Get firstIndex using massifFirstLeaf
  const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

  // Last index = firstIndex + logEntries - 1
  return firstIndex + logEntries - 1n;
}
