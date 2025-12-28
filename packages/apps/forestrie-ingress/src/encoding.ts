/**
 * CBOR encoding utilities for the pull response.
 *
 * Uses positional array format for compact wire representation.
 * See: arbor/docs/adr-0005-cf-do-ingress-pull-encoding.md
 */

import { encode, decode } from "cbor-x";
import type { PullResponse, LogGroup, Entry } from "@canopy/forestrie-ingress-types";

/**
 * Encode a PullResponse to CBOR using positional array format.
 *
 * Wire format:
 * [version, leaseExpiry, [[logId, seqLo, seqHi, [[contentHash, extra0-3], ...]], ...]]
 */
export function encodePullResponse(response: PullResponse): ArrayBuffer {
  const logGroups = response.logGroups.map((group) => [
    group.logId,
    group.seqLo,
    group.seqHi,
    group.entries.map((entry) => [
      entry.contentHash,
      entry.extra0,
      entry.extra1,
      entry.extra2,
      entry.extra3,
    ]),
  ]);

  const encoded = encode([response.version, response.leaseExpiry, logGroups]);
  // Convert to ArrayBuffer (cbor-x returns Uint8Array)
  return new Uint8Array(encoded).buffer;
}

/**
 * Decode a CBOR-encoded pull response back to PullResponse.
 * Used primarily for testing round-trip encoding.
 */
export function decodePullResponse(data: ArrayBuffer): PullResponse {
  const decoded = decode(new Uint8Array(data)) as [
    number,
    number,
    [ArrayBuffer, number, number, [ArrayBuffer, ArrayBuffer | null, ArrayBuffer | null, ArrayBuffer | null, ArrayBuffer | null][]][],
  ];

  const [version, leaseExpiry, logGroupsRaw] = decoded;

  const logGroups: LogGroup[] = logGroupsRaw.map((groupRaw) => {
    const [logId, seqLo, seqHi, entriesRaw] = groupRaw;
    const entries: Entry[] = entriesRaw.map((entryRaw) => ({
      contentHash: entryRaw[0],
      extra0: entryRaw[1],
      extra1: entryRaw[2],
      extra2: entryRaw[3],
      extra3: entryRaw[4],
    }));

    return { logId, seqLo, seqHi, entries };
  });

  return { version, leaseExpiry, logGroups };
}

/**
 * Encode an ack response to CBOR.
 */
export function encodeAckResponse(deleted: number): ArrayBuffer {
  const encoded = encode({ deleted });
  return new Uint8Array(encoded).buffer;
}

/**
 * Decode a CBOR-encoded ack response.
 */
export function decodeAckResponse(data: ArrayBuffer): { deleted: number } {
  return decode(new Uint8Array(data)) as { deleted: number };
}
