/**
 * RFC 9679 COSE Key Thumbprint URI (FOR-371): the `--iss ckt` issuer form.
 * Golden vector is the worked P-256 example from RFC 9679 §3/§4.
 */
import { describe, expect, it } from "vitest";
import { coseKeyThumbprintUriP256 } from "./cose-key-thumbprint.js";

function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// RFC 9679 example EC2 P-256 key.
const X = hex(
  "65eda5a12577c2bae829437fe338701a10aaa375e1bb5b5de108de439c08551d",
);
const Y = hex(
  "1e52ed75701163f7f9e40ddf9f341b3dc9ba860af7e0ca7ca7e9eecd0084d19c",
);

describe("coseKeyThumbprintUriP256", () => {
  it("matches the RFC 9679 worked example URI", async () => {
    expect(await coseKeyThumbprintUriP256(X, Y)).toBe(
      "urn:ietf:params:oauth:ckt:sha-256:SWvYr63zB-WwjGSwQhv53AFSijRKQ72oj63RZp2iU-w",
    );
  });

  it("accepts the uncompressed x||y form", async () => {
    const xy = new Uint8Array(64);
    xy.set(X, 0);
    xy.set(Y, 32);
    expect(await coseKeyThumbprintUriP256(xy)).toBe(
      await coseKeyThumbprintUriP256(X, Y),
    );
  });

  it("rejects coordinates that are not 32 bytes", async () => {
    await expect(coseKeyThumbprintUriP256(X.slice(1), Y)).rejects.toThrow(/32/);
  });
});
