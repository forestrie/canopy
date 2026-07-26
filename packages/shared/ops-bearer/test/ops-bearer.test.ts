import { describe, expect, it } from "vitest";
import { checkBearer } from "../src/index.js";

function req(auth?: string): Request {
  return new Request("http://localhost/", {
    headers: auth ? { Authorization: auth } : {},
  });
}

describe("checkBearer", () => {
  it("accepts the exact token", () => {
    expect(checkBearer(req("Bearer sekret"), "sekret")).toBe("ok");
  });

  it("fails closed on an unset expected token", () => {
    expect(checkBearer(req("Bearer anything"), "")).toBe("missing");
  });

  it("is missing without a Bearer header", () => {
    expect(checkBearer(req(), "sekret")).toBe("missing");
    expect(checkBearer(req("Basic abc"), "sekret")).toBe("missing");
  });

  it("rejects wrong tokens, including same-length ones", () => {
    expect(checkBearer(req("Bearer sekres"), "sekret")).toBe("invalid");
    expect(checkBearer(req("Bearer longer-token"), "sekret")).toBe("invalid");
  });
});
