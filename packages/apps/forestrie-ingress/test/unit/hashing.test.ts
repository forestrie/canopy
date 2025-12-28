import { describe, expect, it } from "vitest";
import { djb2Hash, assignLog } from "../../src/durableobjects/sequencingqueue";

describe("consistent hashing", () => {
  describe("djb2Hash", () => {
    it("returns consistent hash for same input", () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const hash1 = djb2Hash(data);
      const hash2 = djb2Hash(data);
      expect(hash1).toBe(hash2);
    });

    it("returns different hashes for different inputs", () => {
      const data1 = new Uint8Array([1, 2, 3, 4, 5]);
      const data2 = new Uint8Array([5, 4, 3, 2, 1]);
      expect(djb2Hash(data1)).not.toBe(djb2Hash(data2));
    });

    it("returns non-negative 32-bit integer", () => {
      const data = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const hash = djb2Hash(data);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    });
  });

  describe("assignLog", () => {
    it("returns consistent assignment for same logId", () => {
      const logId = new Uint8Array(16).fill(0x01).buffer;
      const pollers = ["poller-a", "poller-b", "poller-c"];

      const assignment1 = assignLog(logId, pollers);
      const assignment2 = assignLog(logId, pollers);

      expect(assignment1).toBe(assignment2);
    });

    it("distributes different logIds across pollers", () => {
      const pollers = ["poller-a", "poller-b", "poller-c"];
      const assignments = new Set<string>();

      // Generate 100 different logIds and check distribution
      for (let i = 0; i < 100; i++) {
        const logId = new Uint8Array(16);
        logId[0] = i;
        logId[1] = i >> 8;
        assignments.add(assignLog(logId.buffer, pollers));
      }

      // With 100 logIds and 3 pollers, all pollers should receive assignments
      expect(assignments.size).toBe(3);
    });

    it("sorts pollers before assignment", () => {
      const logId = new Uint8Array(16).fill(0x02).buffer;
      const pollers1 = ["poller-c", "poller-a", "poller-b"];
      const pollers2 = ["poller-b", "poller-c", "poller-a"];

      // Same pollers in different order should give same assignment
      expect(assignLog(logId, pollers1)).toBe(assignLog(logId, pollers2));
    });

    it("throws when no pollers available", () => {
      const logId = new Uint8Array(16).fill(0x03).buffer;
      expect(() => assignLog(logId, [])).toThrow("No active pollers");
    });

    it("handles single poller", () => {
      const logId = new Uint8Array(16).fill(0x04).buffer;
      const pollers = ["single-poller"];

      expect(assignLog(logId, pollers)).toBe("single-poller");
    });

    it("reassigns logs when poller removed", () => {
      const logId = new Uint8Array(16).fill(0x05).buffer;
      const pollersOriginal = ["poller-a", "poller-b", "poller-c"];
      const pollersReduced = ["poller-a", "poller-c"];

      const originalAssignment = assignLog(logId, pollersOriginal);
      const reducedAssignment = assignLog(logId, pollersReduced);

      // Assignment may or may not change - we just verify it works
      expect(pollersReduced).toContain(reducedAssignment);

      // If original was poller-b, it must now be reassigned
      if (originalAssignment === "poller-b") {
        expect(reducedAssignment).not.toBe("poller-b");
      }
    });
  });
});
