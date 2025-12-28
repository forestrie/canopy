import { describe, expect, it } from "vitest";
import { encodePullResponse, decodePullResponse } from "../../src/encoding";
import type { PullResponse } from "@canopy/forestrie-ingress-types";

describe("CBOR encoding", () => {
  it("encodes and decodes empty response", () => {
    const response: PullResponse = {
      version: 1,
      leaseExpiry: 1703779200000,
      logGroups: [],
    };

    const encoded = encodePullResponse(response);
    const decoded = decodePullResponse(encoded);

    expect(decoded.version).toBe(1);
    expect(decoded.leaseExpiry).toBe(1703779200000);
    expect(decoded.logGroups).toEqual([]);
  });

  it("round-trips response with entries", () => {
    const logId = new Uint8Array(16).fill(0x01).buffer;
    const contentHash = new Uint8Array(32).fill(0xaa).buffer;
    const extra0 = new Uint8Array(16).fill(0x11).buffer;

    const response: PullResponse = {
      version: 1,
      leaseExpiry: 1703779200000,
      logGroups: [
        {
          logId,
          seqLo: 1,
          seqHi: 3,
          entries: [
            {
              contentHash,
              extra0,
              extra1: null,
              extra2: null,
              extra3: null,
            },
            {
              contentHash,
              extra0: null,
              extra1: null,
              extra2: null,
              extra3: null,
            },
            {
              contentHash,
              extra0: null,
              extra1: null,
              extra2: null,
              extra3: null,
            },
          ],
        },
      ],
    };

    const encoded = encodePullResponse(response);
    const decoded = decodePullResponse(encoded);

    expect(decoded.version).toBe(1);
    expect(decoded.leaseExpiry).toBe(1703779200000);
    expect(decoded.logGroups.length).toBe(1);

    const group = decoded.logGroups[0];
    expect(new Uint8Array(group.logId)).toEqual(new Uint8Array(16).fill(0x01));
    expect(group.seqLo).toBe(1);
    expect(group.seqHi).toBe(3);
    expect(group.entries.length).toBe(3);

    // Check first entry has extras
    expect(new Uint8Array(group.entries[0].contentHash)).toEqual(
      new Uint8Array(32).fill(0xaa),
    );
    expect(new Uint8Array(group.entries[0].extra0!)).toEqual(
      new Uint8Array(16).fill(0x11),
    );
    expect(group.entries[0].extra1).toBeNull();
  });

  it("round-trips response with multiple log groups", () => {
    const logId1 = new Uint8Array(16).fill(0x01).buffer;
    const logId2 = new Uint8Array(16).fill(0x02).buffer;
    const contentHash = new Uint8Array(32).fill(0xbb).buffer;

    const response: PullResponse = {
      version: 1,
      leaseExpiry: 1703779200000,
      logGroups: [
        {
          logId: logId1,
          seqLo: 1,
          seqHi: 2,
          entries: [
            { contentHash, extra0: null, extra1: null, extra2: null, extra3: null },
            { contentHash, extra0: null, extra1: null, extra2: null, extra3: null },
          ],
        },
        {
          logId: logId2,
          seqLo: 3,
          seqHi: 3,
          entries: [
            { contentHash, extra0: null, extra1: null, extra2: null, extra3: null },
          ],
        },
      ],
    };

    const encoded = encodePullResponse(response);
    const decoded = decodePullResponse(encoded);

    expect(decoded.logGroups.length).toBe(2);
    expect(new Uint8Array(decoded.logGroups[0].logId)[0]).toBe(0x01);
    expect(new Uint8Array(decoded.logGroups[1].logId)[0]).toBe(0x02);
    expect(decoded.logGroups[0].entries.length).toBe(2);
    expect(decoded.logGroups[1].entries.length).toBe(1);
  });

  it("produces compact positional array format", () => {
    const response: PullResponse = {
      version: 1,
      leaseExpiry: 1703779200000,
      logGroups: [],
    };

    const encoded = encodePullResponse(response);

    // Verify it's an array with 3 elements: [version, leaseExpiry, logGroups]
    // This confirms positional array format rather than object format
    const bytes = new Uint8Array(encoded);
    // CBOR array of 3 elements starts with 0x83
    expect(bytes[0]).toBe(0x83);
  });
});
