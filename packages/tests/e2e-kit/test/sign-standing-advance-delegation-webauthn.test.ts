/**
 * Standing (advance) delegation from a PASSKEY root (plan-2608-14 4.1): the
 * signing context carries the passkey pair, and the submitted material is the
 * two-gesture WebAuthn ceremony — an ADR-0063-enveloped certificate plus the
 * on-chain assertion (`onchainSignature` + `onchainAuthenticatorData` +
 * `onchainClientDataJSON`), which the coordinator requires together. Hermetic:
 * the coordinator HTTP surface is faked.
 */

import { describe, expect, it } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import { verifyCoseSign1WithParsedKey } from "@forestrie/encoding";
import {
  assembleWebauthnDelegationAlgData,
  decodeDelegatedCoseKeyFromBytes,
  parseDelegatedCoseKeyFromPayload,
  verifyOnchainDelegationSignatureWebauthn,
} from "@forestrie/delegation-cose";
import { base64ToBytes } from "@forestrie/grant-builder";
import {
  bytesToBase64,
  exportEs256RootXy,
  generateEphemeralDelegatedPublicKeyCbor,
  generateEs256RootKeyPair,
} from "../src/coordinator-delegation-helpers.js";
import { signStandingAdvanceDelegation } from "../src/sign-standing-advance-delegation.js";
import type { E2eBootstrapVariant } from "../src/e2e-bootstrap-variant.js";

const LOG_HEX32 = "0123456789abcdef0123456789abcdef";

function fakeRequest(standingKeyB64: string) {
  const posts: Array<{ url: string; data: Record<string, unknown> }> = [];
  const request = {
    get: async () => ({
      ok: () => true,
      status: () => 200,
      json: async () => ({
        entries: [
          { delegatedPublicKey: standingKeyB64, suggestedTtlSeconds: 3600 },
        ],
      }),
    }),
    post: async (url: string, options?: { data?: unknown }) => {
      posts.push({
        url,
        data: (options?.data ?? {}) as Record<string, unknown>,
      });
      return { ok: () => true, status: () => 200, text: async () => "" };
    },
  };
  return { request: request as unknown as APIRequestContext, posts };
}

describe("signStandingAdvanceDelegation (passkey root)", () => {
  it("submits a WebAuthn certificate + on-chain assertion, each verifying under the passkey", async () => {
    const standingKey = await generateEphemeralDelegatedPublicKeyCbor();
    const standingKeyB64 = bytesToBase64(standingKey);
    const { request, posts } = fakeRequest(standingKeyB64);
    const passkeyRootKeyPair = await generateEs256RootKeyPair();
    const root = await exportEs256RootXy(passkeyRootKeyPair);

    const outcome = await signStandingAdvanceDelegation({
      request,
      coordinatorUrl: "https://coord.test",
      coordinatorToken: "t",
      logId: LOG_HEX32,
      logIdHex32: LOG_HEX32,
      signingContext: {
        variant: {} as E2eBootstrapVariant,
        passkeyRootKeyPair,
      },
    });
    expect(outcome.signed).toBe(true);
    expect(posts).toHaveLength(1);
    const body = posts[0]!.data;

    // Certificate: the ADR-0063 envelope under the passkey, UV set.
    const certificate = base64ToBytes(body.certificate as string);
    expect(
      await verifyCoseSign1WithParsedKey(
        certificate,
        { x: root.x, y: root.y, curve: "P-256" },
        { requireUserVerification: true },
      ),
    ).toBe(true);

    // On-chain assertion: all three parts, contract-mirror verifiable over
    // the standing scope [0, horizon].
    expect(typeof body.onchainAuthenticatorData).toBe("string");
    expect(typeof body.onchainClientDataJSON).toBe("string");
    const { x, y } = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(standingKey),
    );
    expect(
      await verifyOnchainDelegationSignatureWebauthn(
        {
          logIdHex: LOG_HEX32,
          mmrStart: body.mmrStart as number,
          mmrEnd: body.mmrEnd as number,
          delegatedKeyX: x,
          delegatedKeyY: y,
        },
        base64ToBytes(body.onchainSignature as string),
        assembleWebauthnDelegationAlgData(
          base64ToBytes(body.onchainAuthenticatorData as string),
          base64ToBytes(body.onchainClientDataJSON as string),
        ),
        root.x,
        root.y,
        { requireUserVerification: true },
      ),
    ).toBe(true);
  });
});
