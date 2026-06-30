import { describe, expect, it } from "vitest";
import { predictCreate3Address } from "../src/univocity/create3-address.js";
import {
  logIdToHex32,
  uupsProxySaltString,
} from "../src/univocity/uups-proxy-salt.js";

/** Mirrors deploy-core/packages/deploy-core/test/fixtures/uups-salt-parity.vector.json */
const vector = {
  logId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  logIdHex32: "a1b2c3d4e5f67890abcdef1234567890",
  saltString:
    "forestrie.eth/univocity/UUPSUnivocity/v1/a1b2c3d4e5f67890abcdef1234567890",
  deployer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const,
  factory: "0x988e1Ef32F200E84197266eC0Fd36cC9a1d849dF" as const,
  expectedProxyAddress: "0xbFb9Ef37B28BD71a89a6D8aFe27eB368CEF17347" as const,
};

describe("counterfactual UUPS salt parity (ADR-0042)", () => {
  it("matches shared vector with deploy-core", () => {
    expect(uupsProxySaltString(vector.logId)).toBe(vector.saltString);
    expect(logIdToHex32(vector.logId)).toBe(vector.logIdHex32);
    const predicted = predictCreate3Address(
      vector.deployer,
      vector.saltString,
      vector.factory,
    );
    expect(predicted.toLowerCase()).toBe(
      vector.expectedProxyAddress.toLowerCase(),
    );
  });
});
