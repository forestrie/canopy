/**
 * Custodian returns ECDSA signatures inside the COSE Sign1 signature bstr as ASN.1 DER
 * (~70–72 bytes for P-256), not raw IEEE P1363. {@link derEcdsaToRawRs} must accept that wire shape.
 *
 * Fixture: one capture from POST api-dev /api/grants/bootstrap (body is mint response base64).
 * Full ES256 verify can still fail if GET :bootstrap/public PEM ≠ signing key (ops).
 */
import { decode as decodeCbor } from "cbor-x";
import { describe, expect, it } from "vitest";
import { derEcdsaToRawRs } from "@canopy/encoding";

const MINT_RESPONSE_B64 = `hNhAWEajASYDeC5hcHBsaWNhdGlvbi9mb3Jlc3RyaWUuY3VzdG9kaWFuLXN0YXRlbWVudCtjYm9yBFAUu/rGourztXMOmw5j2FWm2QEDojoAAQAB2EBYo9kBA6YB2EBYIAAAAAAAAAAAAAAAAAAAAAASPkVn6JsS06RWQmYUF0AAAthAWCAAAAAAAAAAAAAAAAAAAAAAEj5FZ+ibEtOkVkJmFBdAAAPYQEgAAAAAAwAAAQQABQAG2EBYQC/LKyPeeHt0xdBrgRgQWlMX1Trez6ETw85QLX3mP8eFSaW60VZoBh5fbGWvjLvfiQYhMtSZkuuDswzzKZK90vg6AAEAANhASAAAAAAAAAAA2EBYIDtiMrzgOGHpxwd10i0LYn4Gtfgtjfkld2Chu3RoxweD2EBYRzBFAiBidq+AIVWn0PNoCT4BQNWPdP5Md/6FKvuu8GnKsStf+gIhALRDg/vTLmlDdfLigEgEoFSgzQFHTem/eMOdL7pRqZzZ`;

describe("Custodian COSE signature wire (DER)", () => {
  it("parses DER inside Sign1 signature bstr to 64-byte P1363", () => {
    const normalized = MINT_RESPONSE_B64.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(normalized);
    const cose = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) cose[i] = bin.charCodeAt(i);
    const arr = decodeCbor(cose) as unknown[];
    const sig = arr[3] as Uint8Array;
    expect(sig[0]).toBe(0x30);
    expect(sig.length).toBeGreaterThanOrEqual(68);
    expect(sig.length).toBeLessThanOrEqual(72);
    const raw = derEcdsaToRawRs(sig, 32);
    expect(raw.length).toBe(64);
  });
});
