/**
 * MMR index calculation functions for massifs
 *
 * Functions for computing MMR indices from massif metadata.
 */

import { massifLogEntries } from "./massiflogentries.js";
import { massifFirstLeaf } from "../mmr/index.js";

/**
 * Compute the last MMR index in a massif.
 *
 * @param massifHeight - Massif height (1-based)
 * @param massifIndex - Massif index
 * @param blobSize - Size of the massif blob in bytes
 * @returns The last MMR index in the massif
 */
export function computeLastMMRIndex(
  massifHeight: number,
  massifIndex: number,
  blobSize: number,
): bigint {
  // Calculate number of log entries (nodes) in the blob
  // massifLogEntries expects 1-based height
  const logEntries = massifLogEntries(blobSize, massifHeight);

  // Get firstIndex using massifFirstLeaf (also expects 1-based height)
  const firstIndex = massifFirstLeaf(massifHeight, massifIndex);

  // Last index = firstIndex + logEntries - 1
  return firstIndex + logEntries - 1n;
}
