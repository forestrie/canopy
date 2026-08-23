/**
 * Shared base64url codec (RFC 4648 §5, unpadded). Encode must match what
 * WebAuthn clients and the univocity contract (`Base64.encodeURL`) produce
 * for `clientDataJSON.challenge`; decode is strict (canonical, unpadded).
 */

import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "./base64url.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("base64UrlEncode", () => {
  it("matches the RFC 4648 test vectors, unpadded", () => {
    expect(base64UrlEncode(utf8(""))).toBe("");
    expect(base64UrlEncode(utf8("f"))).toBe("Zg");
    expect(base64UrlEncode(utf8("fo"))).toBe("Zm8");
    expect(base64UrlEncode(utf8("foo"))).toBe("Zm9v");
    expect(base64UrlEncode(utf8("foob"))).toBe("Zm9vYg");
    expect(base64UrlEncode(utf8("fooba"))).toBe("Zm9vYmE");
    expect(base64UrlEncode(utf8("foobar"))).toBe("Zm9vYmFy");
  });

  it("uses the url-safe alphabet (- and _, never + / =)", () => {
    const encoded = base64UrlEncode(new Uint8Array([0xfb, 0xef, 0xff]));
    expect(encoded).toBe("--__");
  });
});

describe("base64UrlDecode", () => {
  it("round-trips arbitrary bytes at every length remainder", () => {
    for (let len = 0; len < 12; len++) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + len) & 0xff);
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(
        Array.from(bytes),
      );
    }
  });

  it("rejects padding, standard-alphabet characters, and bad lengths", () => {
    expect(() => base64UrlDecode("Zg==")).toThrow(/invalid character/);
    expect(() => base64UrlDecode("a+b/")).toThrow(/invalid character/);
    expect(() => base64UrlDecode("aaaaa")).toThrow(/invalid length/);
  });

  it("rejects non-canonical trailing bits", () => {
    // "AB" decodes to one byte; the low 4 bits of 'B' must be zero ("AA"…"AQ"
    // are the canonical single-byte encodings, "AB" is not).
    expect(() => base64UrlDecode("AB")).toThrow(/non-canonical/);
    expect(Array.from(base64UrlDecode("AQ"))).toEqual([0x01]);
  });
});
