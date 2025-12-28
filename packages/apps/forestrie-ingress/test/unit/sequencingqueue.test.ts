/**
 * SequencingQueue Durable Object basic instantiation and schema tests.
 *
 * Method-specific tests are in separate files:
 * - sequencingqueue-enqueue.test.ts
 * - sequencingqueue-pull.test.ts
 * - sequencingqueue-ack.test.ts
 * - sequencingqueue-stats.test.ts
 */

import { describe, expect, it } from "vitest";
import { getStub } from "./sequencingqueue-fixture";

describe("SequencingQueue Durable Object", () => {
  it("can be instantiated via idFromName('global')", async () => {
    const stub = getStub("global");
    expect(stub).toBeDefined();
  });

  describe("ensureSchema", () => {
    it("is idempotent - multiple calls do not error", async () => {
      const stub = getStub("schema-idempotent-test");

      // Multiple operations should work (each calls ensureSchema internally)
      await stub.stats();
      await stub.stats();

      const logId = new Uint8Array(16).fill(0x09).buffer;
      const contentHash = new Uint8Array(32).fill(0x00).buffer;
      await stub.enqueue(logId, contentHash);
      await stub.stats();

      // If we got here without error, schema is idempotent
      expect(true).toBe(true);
    });
  });
});
