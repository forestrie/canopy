import { describe, expect, it, vi, afterEach } from "vitest";
import {
  checkPinCoherence,
  formatPinCoherenceReport,
  assertPinCoherence,
  type PinContract,
} from "../src/pin-coherence.js";

/**
 * The four incidents of 2026-07-31 are the fixtures: each one cost a CI
 * round-trip to diagnose from a deep 422/404, and each must now be a
 * named preflight violation naming the store to fix.
 */

const KS256_KEY = `0x${"11".repeat(32)}`;
/** Address for KS256_KEY — pinned so a derivation change is visible. */
const KS256_ADDR = "19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
const RPC = "https://rpc.test";

function contract(pins: PinContract["pins"]): PinContract {
  return { schemaVersion: 1, suite: "fixture", pins };
}

/** ABI-encode `(int256 alg, bytes key)` the way bootstrapConfig() returns it. */
function bootstrapConfigResult(alg: number, keyHex: string): string {
  const algWord = BigInt.asUintN(256, BigInt(alg))
    .toString(16)
    .padStart(64, "0");
  const offset = (64).toString(16).padStart(64, "0");
  const len = (keyHex.length / 2).toString(16).padStart(64, "0");
  const body = keyHex.padEnd(Math.ceil(keyHex.length / 64) * 64, "0");
  return `0x${algWord}${offset}${len}${body}`;
}

function stubRpc(result: string | { error: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      typeof result === "string"
        ? new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))
        : new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { message: result.error },
            }),
          ),
    ),
  );
}

const KS256_PIN = {
  id: "ks256-bootstrap",
  instanceVar: "INSTANCE",
  keySecret: "KEY",
  keyKind: "secp256k1-private-hex" as const,
  alg: "ks256" as const,
  chainVar: "CHAIN",
  invariants: ["instanceHasCode" as const, "keyMatchesInstance" as const],
};

describe("pin coherence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes when the held key IS the instance's on-chain bootstrap key", async () => {
    stubRpc(bootstrapConfigResult(-65799, KS256_ADDR));
    const report = await checkPinCoherence(contract([KS256_PIN]), {
      rpcUrl: RPC,
      env: { INSTANCE: "0xabc", KEY: KS256_KEY, CHAIN: "84532" },
    });
    expect(report.violations).toEqual([]);
    expect(report.checked).toEqual(["ks256-bootstrap"]);
  });

  it("incident 1: key and instance from different generations", async () => {
    // What the byok spec hit as a 422 mid-suite.
    stubRpc(bootstrapConfigResult(-65799, "6eb277c8".padEnd(40, "0")));
    const report = await checkPinCoherence(contract([KS256_PIN]), {
      rpcUrl: RPC,
      env: { INSTANCE: "0x44f4", KEY: KS256_KEY, CHAIN: "84532" },
    });
    expect(report.violations).toHaveLength(1);
    const v = report.violations[0]!;
    expect(v.invariant).toBe("keyMatchesInstance");
    expect(v.expected).toContain(KS256_ADDR);
    expect(v.actual).toContain("6eb277c8");
    // The actionable part: which store holds each side.
    expect(v.stores).toEqual({ instance: "INSTANCE", key: "KEY" });
  });

  it("incident 2: instance pinned for the wrong algorithm", async () => {
    // The ES256 pin that actually named a KS256-bootstrapped contract.
    stubRpc(bootstrapConfigResult(-65799, KS256_ADDR));
    const report = await checkPinCoherence(
      contract([{ ...KS256_PIN, id: "es256-bootstrap", alg: "es256" }]),
      {
        rpcUrl: RPC,
        env: { INSTANCE: "0x7A4E", KEY: KS256_KEY, CHAIN: "84532" },
      },
    );
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.expected).toContain("alg -7");
    expect(report.violations[0]!.actual).toContain("alg -65799");
  });

  it("incident 3: half-configured pin (one side empty)", async () => {
    // E2E_UNIVOCITY_ADDRESS_ES256_BOOTSTRAP was empty while its PEM was set.
    const report = await checkPinCoherence(contract([KS256_PIN]), {
      rpcUrl: RPC,
      env: { KEY: KS256_KEY, CHAIN: "84532" },
    });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.invariant).toBe("pairPresent");
    expect(report.violations[0]!.actual).toBe("only KEY");
  });

  it("incident 4: pinned instance is not deployed / unreadable", async () => {
    stubRpc({ error: "execution reverted" });
    const report = await checkPinCoherence(contract([KS256_PIN]), {
      rpcUrl: RPC,
      env: { INSTANCE: "0xdead", KEY: KS256_KEY, CHAIN: "84532" },
    });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.detail).toContain(
      "could not read bootstrapConfig()",
    );
  });

  it("skips a pin this tier does not use, rather than failing it", async () => {
    const report = await checkPinCoherence(contract([KS256_PIN]), {
      rpcUrl: RPC,
      env: { CHAIN: "84532" },
    });
    expect(report.violations).toEqual([]);
    expect(report.skipped).toEqual([
      { pin: "ks256-bootstrap", reason: "INSTANCE and KEY both unset" },
    ]);
  });

  it("the report names the pin, both identities and the stores", async () => {
    stubRpc(bootstrapConfigResult(-65799, "6eb277c8".padEnd(40, "0")));
    const report = await checkPinCoherence(contract([KS256_PIN]), {
      rpcUrl: RPC,
      env: { INSTANCE: "0x44f4", KEY: KS256_KEY, CHAIN: "84532" },
    });
    const text = formatPinCoherenceReport(report);
    expect(text).toContain("ks256-bootstrap");
    expect(text).toContain("instance=INSTANCE key=KEY");
    expect(() => assertPinCoherence(report)).toThrow(/keyMatchesInstance/);
  });
});

/**
 * The fifth incident, 2026-08-02: canopy v0.1.8's release was blocked by a
 * pin that was correctly signalling "not configured".
 *
 * `e2e-univocity-ci-resolve-pins.sh` fills an unconfigured KS256 address with
 * KS256_UNIVOCITY_MANIFEST_PLACEHOLDER. Read as a real instance that is a
 * half-configured pin, and the gate fails a lane that is behaving correctly.
 */
describe("absentWhen — declared not-configured sentinels", () => {
  const PLACEHOLDER = "0x0000000000000000000000000000000000000002";

  const sentinelPin = (absentWhen?: string[]) =>
    contract([
      {
        id: "ks256-bootstrap",
        instanceVar: "KS_ADDR",
        keyVar: "KS_SIGNER",
        keyKind: "eth-address",
        alg: "ks256",
        chainVar: "CHAIN",
        invariants: ["instanceHasCode", "keyMatchesInstance"],
        ...(absentWhen ? { absentWhen } : {}),
      },
    ]);

  it("skips the pin, naming the placeholder, when the sentinel is the address", async () => {
    const report = await checkPinCoherence(sentinelPin([PLACEHOLDER]), {
      rpcUrl: RPC,
      env: { KS_ADDR: PLACEHOLDER, CHAIN: "84532" },
    });
    expect(report.violations).toHaveLength(0);
    expect(report.checked).toHaveLength(0);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]!.reason).toContain("not-configured placeholder");
    expect(report.skipped[0]!.reason).toContain(PLACEHOLDER);
  });

  it("without absentWhen the same state is a violation — the v0.1.8 regression", async () => {
    const report = await checkPinCoherence(sentinelPin(), {
      rpcUrl: RPC,
      env: { KS_ADDR: PLACEHOLDER, CHAIN: "84532" },
    });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.invariant).toBe("pairPresent");
  });

  it("matches the sentinel case-insensitively", async () => {
    const report = await checkPinCoherence(sentinelPin([PLACEHOLDER]), {
      rpcUrl: RPC,
      env: {
        KS_ADDR: PLACEHOLDER.toUpperCase().replace("0X", "0x"),
        CHAIN: "84532",
      },
    });
    expect(report.skipped).toHaveLength(1);
  });

  it("still flags a placeholder address that arrives WITH a key — a real misconfiguration", async () => {
    // A key with no real contract is not "not configured"; it is a lane that
    // believes it is wired and is not. That must never be silently skipped.
    const report = await checkPinCoherence(sentinelPin([PLACEHOLDER]), {
      rpcUrl: RPC,
      env: {
        KS_ADDR: PLACEHOLDER,
        KS_SIGNER: "0x1111111111111111111111111111111111111111",
        CHAIN: "84532",
      },
    });
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.invariant).toBe("pairPresent");
    expect(report.violations[0]!.actual).toContain("only KS_SIGNER");
  });

  it("does not skip a real address just because absentWhen is declared", async () => {
    const report = await checkPinCoherence(sentinelPin([PLACEHOLDER]), {
      rpcUrl: RPC,
      env: {
        KS_ADDR: "0x00000000000000000000000000000000000000ff",
        CHAIN: "84532",
      },
    });
    expect(report.skipped).toHaveLength(0);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0]!.invariant).toBe("pairPresent");
  });
});
