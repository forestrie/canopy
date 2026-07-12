/**
 * CBOR encoding utilities for the pull response.
 *
 * Uses positional array format for compact wire representation.
 * See: arbor/docs/adr-0005-cf-do-ingress-pull-encoding.md
 */

import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import type {
  PullResponse,
  LogGroup,
  Entry,
} from "@canopy/forestrie-ingress-types";

/**
 * Encode a PullResponse to CBOR using positional array format.
 *
 * Wire format:
 * [version, leaseExpiry, [[logId, seqLo, seqHi, [[contentHash, extra0-3], ...]], ...]]
 */
export function encodePullResponse(response: PullResponse): ArrayBuffer {
  const logGroups = response.logGroups.map((group) => [
    group.logId,
    BigInt(group.seqLo),
    BigInt(group.seqHi),
    group.entries.map((entry) => [
      entry.contentHash,
      entry.extra0,
      entry.extra1,
      entry.extra2,
      entry.extra3,
    ]),
  ]);

  // Use BigInt for numeric fields to ensure CBOR encodes them as uint64
  const encoded = encodeCborDeterministic([
    response.version,
    BigInt(response.leaseExpiry),
    logGroups,
  ]);
  // Copy into a standalone ArrayBuffer (decoder returns a Uint8Array view)
  return new Uint8Array(encoded).buffer;
}

/**
 * Decode a CBOR-encoded pull response back to PullResponse.
 * Used primarily for testing round-trip encoding.
 */
export function decodePullResponse(data: ArrayBuffer): PullResponse {
  const decoded = decodeCborDeterministic(new Uint8Array(data)) as [
    number | bigint,
    number | bigint,
    [
      ArrayBuffer,
      number | bigint,
      number | bigint,
      [
        ArrayBuffer,
        ArrayBuffer | null,
        ArrayBuffer | null,
        ArrayBuffer | null,
        ArrayBuffer | null,
      ][],
    ][],
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

    return { logId, seqLo: Number(seqLo), seqHi: Number(seqHi), entries };
  });

  return {
    version: Number(version),
    leaseExpiry: Number(leaseExpiry),
    logGroups,
  };
}

/**
 * Encode an ack response to CBOR.
 */
export function encodeAckResponse(acked: number): ArrayBuffer {
  const encoded = encodeCborDeterministic({ acked });
  return new Uint8Array(encoded).buffer;
}

/**
 * Decode a CBOR-encoded ack response.
 */
export function decodeAckResponse(data: ArrayBuffer): { acked: number } {
  // Maps always decode to a JS Map; read the field by key.
  const decoded = decodeCborDeterministic(new Uint8Array(data));
  const acked =
    decoded instanceof Map
      ? decoded.get("acked")
      : (decoded as { acked: unknown }).acked;
  return { acked: Number(acked) };
}
