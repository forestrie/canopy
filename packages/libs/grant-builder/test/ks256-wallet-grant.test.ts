import { describe, expect, it } from "vitest";
import {
  assertRootGrantTransparentStatement,
  base64ToBytes,
  dataLogCreateExtendFlags,
  ks256AddressFromPrivateKeyHex,
  mintKs256RootGrantWithWalletKey,
  randomKs256PrivateKeyHex,
  signGrantWithKs256WalletKey,
  uuidToBytes,
  verifyKs256GrantStatement,
  type Grant,
} from "../src/index.js";

const ROOT_LOG_ID = "0198c1a2-3b4c-7d5e-8f60-718293a4b5c6";

describe("KS256 wallet grant assembly", () => {
  it("mints a root grant that verifies via ecrecover", () => {
    const sk = randomKs256PrivateKeyHex();
    const address = ks256AddressFromPrivateKeyHex(sk);
    expect(address.length).toBe(20);

    const { grantBase64, grantData } = mintKs256RootGrantWithWalletKey({
      rootLogId: ROOT_LOG_ID,
      bootstrapAddress20: address,
      ks256PrivateKeyHex: sk,
    });
    expect(grantData).toEqual(address);
    expect(() =>
      assertRootGrantTransparentStatement(grantBase64),
    ).not.toThrow();
    expect(verifyKs256GrantStatement(base64ToBytes(grantBase64), address)).toBe(
      true,
    );
  });

  it("rejects a private key that does not match the bootstrap address", () => {
    const sk = randomKs256PrivateKeyHex();
    const otherAddress = ks256AddressFromPrivateKeyHex(
      randomKs256PrivateKeyHex(),
    );
    expect(() =>
      mintKs256RootGrantWithWalletKey({
        rootLogId: ROOT_LOG_ID,
        bootstrapAddress20: otherAddress,
        ks256PrivateKeyHex: sk,
      }),
    ).toThrow(/does not match on-chain bootstrapConfig/);
  });

  it("signGrantWithKs256WalletKey verifies against the wallet address only", () => {
    const sk = randomKs256PrivateKeyHex();
    const address = ks256AddressFromPrivateKeyHex(sk);
    const id16 = uuidToBytes(ROOT_LOG_ID);
    const grant: Grant = {
      logId: id16,
      ownerLogId: id16,
      grant: dataLogCreateExtendFlags(),
      maxHeight: 0,
      minGrowth: 0,
      grantData: address,
    };
    const b64 = signGrantWithKs256WalletKey(grant, sk);
    const sign1 = base64ToBytes(b64);
    expect(verifyKs256GrantStatement(sign1, address)).toBe(true);
    const stranger = ks256AddressFromPrivateKeyHex(randomKs256PrivateKeyHex());
    expect(verifyKs256GrantStatement(sign1, stranger)).toBe(false);
  });
});
