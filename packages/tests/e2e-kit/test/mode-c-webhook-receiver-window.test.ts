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
    expect(receiverSigningWindow({ mmrStart: 7, mmrEnd: 21 })).toEqual({
      mmrStart: 7,
      mmrEnd: 21,
    });
  });

  it("signs [0, horizon] for a window-less event", () => {
    expect(receiverSigningWindow({})).toEqual({
      mmrStart: 0,
      mmrEnd: ADVANCE_HORIZON_MMR_END,
    });
  });
});
