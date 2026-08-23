/**
 * WebAuthn on-chain delegation proof intake and issue (plan-2608-13 phase 2):
 * a passkey root submits `onchainSignature` plus the raw assertion parts; the
 * coordinator verifies via the univocity ADR-0008 contract mirror, persists
 * the parts, and issue re-assembles the proof with the ES256_WEBAUTHN header
 * and 3-element `algData`. ES256/KS256 responses remain algData-free.
 */

import { randomUUID } from "node:crypto";
import {
  decodeCborDeterministic,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import { describe, expect, it } from "vitest";
import {
  decodeDelegatedCoseKeyFromBytes,
  parseDelegatedCoseKeyFromPayload,
  signOnchainDelegationEs256,
  verifyOnchainDelegationSignatureWebauthn,
} from "@forestrie/delegation-cose";
import { bytesToBase64 } from "../../src/encoding.js";
import {
  hex32ToWireLogIdBytes,
  normalizeLogIdToHex32,
} from "../../src/log-id.js";
import {
  buildTestByokMaterial,
  buildTestByokWebauthnMaterial,
  generateTestRootKeyPair,
  testDelegatedCoseKey,
} from "./byok-material-fixture.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";

const TEST_TOKEN = "test-coordinator-token";

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

async function registerEs256Root(
  logUuid: string,
  x: Uint8Array,
  y: Uint8Array,
): Promise<void> {
  const res = await fetchWithDoRetry(
    `http://localhost/api/logs/${logUuid}/public-root`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        alg: "ES256",
        x: bytesToBase64(x),
        y: bytesToBase64(y),
      }),
    },
  );
  expect(res.status).toBe(200);
}

interface WebauthnSubmission {
  logHex32: string;
  mmrStart: number;
  mmrEnd: number;
  delegatedPublicKey: Uint8Array;
  issuedAt: number;
  expiresAt: number;
  certificate: Uint8Array;
}

async function submitCertificate(
  sub: WebauthnSubmission,
  onchain?: {
    signature: Uint8Array;
    authenticatorData?: Uint8Array;
    clientDataJSON?: Uint8Array;
  },
): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations/certificate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      logId: sub.logHex32,
      mmrStart: sub.mmrStart,
      mmrEnd: sub.mmrEnd,
      delegatedPublicKey: bytesToBase64(sub.delegatedPublicKey),
      certificate: bytesToBase64(sub.certificate),
      issuedAt: sub.issuedAt,
      expiresAt: sub.expiresAt,
      ...(onchain
        ? { onchainSignature: bytesToBase64(onchain.signature) }
        : {}),
      ...(onchain?.authenticatorData
        ? {
            onchainAuthenticatorData: bytesToBase64(onchain.authenticatorData),
          }
        : {}),
      ...(onchain?.clientDataJSON
        ? { onchainClientDataJSON: bytesToBase64(onchain.clientDataJSON) }
        : {}),
    }),
  });
}

async function issueDelegation(
  sub: Pick<
    WebauthnSubmission,
    "logHex32" | "mmrStart" | "mmrEnd" | "delegatedPublicKey"
  >,
): Promise<Response> {
  return fetchWithDoRetry("http://localhost/api/delegations", {
    method: "POST",
    headers: authHeaders({
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    }),
    body: encodeCborDeterministic({
      version: 1,
      logId: hex32ToWireLogIdBytes(sub.logHex32),
      mmrStart: sub.mmrStart,
      mmrEnd: sub.mmrEnd,
      algorithm: "ES256",
      delegatedPublicKey: sub.delegatedPublicKey,
      requestedTtlSeconds: 3600,
    }),
  });
}

interface OnchainProofWire {
  protectedHeader: Uint8Array;
  delegationKey: Uint8Array;
  mmrStart: number | bigint;
  mmrEnd: number | bigint;
  signature: Uint8Array;
  algData?: Uint8Array[];
  hasAlgDataKey: boolean;
}

function decodeIssueResponse(bytes: Uint8Array): {
  certificate?: Uint8Array;
  onchainProof?: OnchainProofWire;
} {
  const m = decodeCborDeterministic(bytes) as Map<string, unknown>;
  const proofMap = m.get("onchainProof") as Map<string, unknown> | undefined;
  const onchainProof = proofMap
    ? {
        protectedHeader: proofMap.get("protectedHeader") as Uint8Array,
        delegationKey: proofMap.get("delegationKey") as Uint8Array,
        mmrStart: proofMap.get("mmrStart") as number | bigint,
        mmrEnd: proofMap.get("mmrEnd") as number | bigint,
        signature: proofMap.get("signature") as Uint8Array,
        algData: proofMap.get("algData") as Uint8Array[] | undefined,
        hasAlgDataKey: proofMap.has("algData"),
      }
    : undefined;
  return {
    certificate: m.get("certificate") as Uint8Array | undefined,
    onchainProof,
  };
}

describe("WebAuthn BYOK on-chain delegation proof", () => {
  it("accepts assertion material and issues the -65800 proof with algData", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = testDelegatedCoseKey(21);
    const m = await buildTestByokWebauthnMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });
    await registerEs256Root(logUuid, m.x, m.y);

    const sub: WebauthnSubmission = {
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      issuedAt: m.issuedAt,
      expiresAt: m.expiresAt,
      certificate: m.certificate,
    };
    const putRes = await submitCertificate(sub, {
      signature: m.onchainSignature,
      authenticatorData: m.onchainAuthenticatorData,
      clientDataJSON: m.onchainClientDataJSON,
    });
    expect(putRes.status).toBe(200);

    const issueRes = await issueDelegation(sub);
    expect(issueRes.status).toBe(200);
    const resp = decodeIssueResponse(
      new Uint8Array(await issueRes.arrayBuffer()),
    );
    expect(resp.certificate).toBeInstanceOf(Uint8Array);
    const wire = resp.onchainProof!;
    expect(wire).toBeDefined();
    // ES256_WEBAUTHN protected header {1: -65800}.
    expect(Array.from(wire.protectedHeader)).toEqual([
      0xa1, 0x01, 0x3a, 0x00, 0x01, 0x01, 0x07,
    ]);
    expect(Array.from(wire.signature)).toEqual(Array.from(m.onchainSignature));
    expect(wire.algData).toBeDefined();
    expect(wire.algData!.length).toBe(3);
    expect(Array.from(wire.algData![0]!)).toEqual(
      Array.from(m.onchainAuthenticatorData),
    );
    expect(Array.from(wire.algData![1]!)).toEqual(
      Array.from(m.onchainClientDataJSON),
    );
    expect(wire.algData![2]!.length).toBe(16);

    // The emitted proof is contract-acceptable: the ADR-0008 mirror verifies
    // the wire parts against the root over the certificate's signed range.
    const delegated = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
    );
    expect(
      await verifyOnchainDelegationSignatureWebauthn(
        {
          logIdHex: logHex32,
          mmrStart: Number(wire.mmrStart),
          mmrEnd: Number(wire.mmrEnd),
          delegatedKeyX: delegated.x,
          delegatedKeyY: delegated.y,
        },
        wire.signature,
        wire.algData!,
        m.x,
        m.y,
      ),
    ).toBe(true);
  });

  it("rebuilds the proof from the signed range under coverage retrieval", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = testDelegatedCoseKey(23);
    const m = await buildTestByokWebauthnMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });
    await registerEs256Root(logUuid, m.x, m.y);

    const sub: WebauthnSubmission = {
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      issuedAt: m.issuedAt,
      expiresAt: m.expiresAt,
      certificate: m.certificate,
    };
    const putRes = await submitCertificate(sub, {
      signature: m.onchainSignature,
      authenticatorData: m.onchainAuthenticatorData,
      clientDataJSON: m.onchainClientDataJSON,
    });
    expect(putRes.status).toBe(200);

    // Narrow issue window inside the signed range (review V1 parity): the
    // proof must carry the CERTIFICATE's range or the challenge cannot bind.
    const issueRes = await issueDelegation({
      logHex32,
      mmrStart: 100,
      mmrEnd: 200,
      delegatedPublicKey,
    });
    expect(issueRes.status).toBe(200);
    const resp = decodeIssueResponse(
      new Uint8Array(await issueRes.arrayBuffer()),
    );
    const wire = resp.onchainProof!;
    expect(wire).toBeDefined();
    expect(Number(wire.mmrStart)).toBe(0);
    expect(Number(wire.mmrEnd)).toBe(16383);
    const delegated = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
    );
    expect(
      await verifyOnchainDelegationSignatureWebauthn(
        {
          logIdHex: logHex32,
          mmrStart: 0,
          mmrEnd: 16383,
          delegatedKeyX: delegated.x,
          delegatedKeyY: delegated.y,
        },
        wire.signature,
        wire.algData!,
        m.x,
        m.y,
      ),
    ).toBe(true);
  });

  it("rejects an assertion signed by a different passkey with 400", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const otherKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = testDelegatedCoseKey(25);
    const m = await buildTestByokWebauthnMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });
    await registerEs256Root(logUuid, m.x, m.y);
    const evil = await buildTestByokWebauthnMaterial({
      rootKeyPair: otherKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });

    const sub: WebauthnSubmission = {
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      issuedAt: m.issuedAt,
      expiresAt: m.expiresAt,
      certificate: m.certificate,
    };
    const putRes = await submitCertificate(sub, {
      signature: evil.onchainSignature,
      authenticatorData: evil.onchainAuthenticatorData,
      clientDataJSON: evil.onchainClientDataJSON,
    });
    expect(putRes.status).toBe(400);

    const issueRes = await issueDelegation(sub);
    expect(issueRes.status).toBe(202);
  });

  it("rejects partial assertion material with 400", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = testDelegatedCoseKey(27);
    const m = await buildTestByokWebauthnMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });
    await registerEs256Root(logUuid, m.x, m.y);

    const sub: WebauthnSubmission = {
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      issuedAt: m.issuedAt,
      expiresAt: m.expiresAt,
      certificate: m.certificate,
    };
    const putRes = await submitCertificate(sub, {
      signature: m.onchainSignature,
      authenticatorData: m.onchainAuthenticatorData,
      // clientDataJSON deliberately missing
    });
    expect(putRes.status).toBe(400);
  });

  it("keeps the plain ES256 issue response algData-free (byte compat)", async () => {
    const logUuid = randomUUID();
    const logHex32 = normalizeLogIdToHex32(logUuid);
    const rootKeyPair = await generateTestRootKeyPair();
    const delegatedPublicKey = testDelegatedCoseKey(29);
    const material = await buildTestByokMaterial({
      rootKeyPair,
      logIdHex32: logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
    });
    await registerEs256Root(logUuid, material.x, material.y);

    const delegated = parseDelegatedCoseKeyFromPayload(
      decodeDelegatedCoseKeyFromBytes(delegatedPublicKey),
    );
    const proof = await signOnchainDelegationEs256(
      {
        logIdHex: logHex32,
        mmrStart: 0,
        mmrEnd: 16383,
        delegatedKeyX: delegated.x,
        delegatedKeyY: delegated.y,
      },
      rootKeyPair,
    );
    const sub: WebauthnSubmission = {
      logHex32,
      mmrStart: 0,
      mmrEnd: 16383,
      delegatedPublicKey,
      issuedAt: material.issuedAt,
      expiresAt: material.expiresAt,
      certificate: material.certificate,
    };
    const putRes = await submitCertificate(sub, {
      signature: proof.signature,
    });
    expect(putRes.status).toBe(200);

    const issueRes = await issueDelegation(sub);
    expect(issueRes.status).toBe(200);
    const resp = decodeIssueResponse(
      new Uint8Array(await issueRes.arrayBuffer()),
    );
    const wire = resp.onchainProof!;
    expect(wire).toBeDefined();
    expect(wire.hasAlgDataKey).toBe(false);
  });
});
