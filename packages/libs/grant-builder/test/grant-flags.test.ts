import { describe, expect, it } from "vitest";
import {
  dataLogCreateExtendFlags,
  dataLogExtendFlags,
  hasCreateAndExtend,
  hasDataLogClass,
  hasExtendCapability,
  isDataLogStatementGrantFlags,
} from "../src/index.js";

describe("dataLogExtendFlags — extend-only writer grant (ADR-0052)", () => {
  it("sets GF_EXTEND (byte 3 = 0x02) and GF_DATA_LOG (byte 7 = 0x02), NOT GF_CREATE", () => {
    const flags = dataLogExtendFlags();
    expect(flags.length).toBe(8);
    expect(flags[3]).toBe(0x02);
    expect(flags[7]).toBe(0x02);
  });

  it("has extend capability and data-log class but NOT create+extend", () => {
    const flags = dataLogExtendFlags();
    expect(hasExtendCapability(flags)).toBe(true);
    expect(hasDataLogClass(flags)).toBe(true);
    expect(hasCreateAndExtend(flags)).toBe(false);
  });

  it("is accepted as a data-log statement-registration grant (writer path)", () => {
    expect(isDataLogStatementGrantFlags(dataLogExtendFlags())).toBe(true);
  });

  it("differs from dataLogCreateExtendFlags only by the GF_CREATE bit", () => {
    const create = dataLogCreateExtendFlags();
    const extend = dataLogExtendFlags();
    expect(hasCreateAndExtend(create)).toBe(true);
    expect(hasCreateAndExtend(extend)).toBe(false);
    expect(create[7]).toBe(extend[7]); // same class (GF_DATA_LOG)
    expect(create[3] & 0x02).toBe(extend[3] & 0x02); // both carry GF_EXTEND
  });
});
