/**
 * Window the Mode C test receiver signs (FOR-612).
 *
 * The coordinator's signing-route-setup push is window-less: the signer
 * chooses its bounds (ADR-0050 Decision item 2). It used to carry a
 * literal [0, 0], so the receiver could sign the event as stated.
 */

import { describe, expect, it } from "vitest";
import { receiverSigningWindow } from "../src/mode-c-webhook-receiver.js";
import { ADVANCE_HORIZON_MMR_END } from "../src/sign-standing-advance-delegation.js";

describe("receiverSigningWindow", () => {
  it("signs a demanded window as stated", () => {
    expect(receiverSigningWindow({ mmrStart: "7", mmrEnd: "21" })).toEqual({
      mmrStart: 7n,
      mmrEnd: 21n,
    });
  });

  it("signs [0, horizon] for a window-less event", () => {
    expect(receiverSigningWindow({})).toEqual({
      mmrStart: 0n,
      mmrEnd: ADVANCE_HORIZON_MMR_END,
    });
  });

  // The event carries decimal strings (canopy plan-2611-01 D1, FOR-613).
  it("reads a window above 2^53 exactly", () => {
    expect(
      receiverSigningWindow({
        mmrStart: "9007199254740993",
        mmrEnd: "18446744073709551615",
      }),
    ).toEqual({
      mmrStart: (1n << 53n) + 1n,
      mmrEnd: (1n << 64n) - 1n,
    });
  });

  it("refuses a JSON-number or non-canonical bound", () => {
    expect(() =>
      receiverSigningWindow({
        mmrStart: 7 as unknown as string,
        mmrEnd: "21",
      }),
    ).toThrow(/mmrStart/);
    expect(() =>
      receiverSigningWindow({ mmrStart: "0", mmrEnd: "021" }),
    ).toThrow(/mmrEnd/);
  });
});
