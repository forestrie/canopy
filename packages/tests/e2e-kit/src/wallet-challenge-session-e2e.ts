/**
 * Wallet-challenge control-plane session helpers for coordinator e2e.
 * Mirrors mandate control-plane-session-core + coordinator unit tests.
 */

import type { APIRequestContext } from "@playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import {
  bytesToBase64,
  exportEs256RootXy,
  generateEs256RootKeyPair,
  uploadBootstrapKs256PublicRoot,
  uploadByokRootPublicKey,
} from "./coordinator-delegation-helpers.js";

export type ControlPlaneScope =
  | "delegations:read"
  | "logs:enabled:read"
  | "logs:enabled:write"
  | "logs:signing-route:read"
  | "logs:signing-route:write"
  | "onboard:bind";

export interface WalletChallengeEnvelope {
  version: "wcc-1";
  domain: string;
  coordinatorOrigin: string;
  authLogId: string;
  scopes: ControlPlaneScope[];
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  chainId?: string;
}

export interface ControlPlaneSession {
  token: string;
  expiresAt: number;
  authLogId: string;
  scopes: ControlPlaneScope[];
}

type HttpRequest = Pick<
  APIRequestContext,
  "post" | "get" | "put" | "delete" | "fetch"
>;

/** Canonical wcc-1 UTF-8 challenge text (KS256 personal_sign and ES256 ECDSA). */
export function buildControlPlaneMessage(
  envelope: WalletChallengeEnvelope,
): string {
  const scopes = envelope.scopes.join(" ");
  const chainLine =
    envelope.chainId !== undefined ? `Chain ID: ${envelope.chainId}\n` : "";
  return [
    `${envelope.domain} wants you to authorize delegation control-plane access:`,
    `Auth log: ${envelope.authLogId}`,
    `Scopes: ${scopes}`,
    `Nonce: ${envelope.nonce}`,
    `Issued At: ${envelope.issuedAt}`,
    `Expiration Time: ${envelope.expiresAt}`,
    chainLine.trimEnd(),
    `Coordinator: ${envelope.coordinatorOrigin}`,
    `Version: ${envelope.version}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function sessionAuthHeaders(
  token: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

function normalizePrivateKeyHex(hex: string): `0x${string}` {
  const trimmed = hex.trim().replace(/^0x/i, "");
  return `0x${trimmed}` as `0x${string}`;
}

async function postChallenge(
  request: HttpRequest,
  coordinatorUrl: string,
  authLogId: string,
  scopes: ControlPlaneScope[],
): Promise<WalletChallengeEnvelope> {
  const res = await request.post(`${coordinatorUrl}/api/auth/challenge`, {
    headers: { "Content-Type": "application/json" },
    data: { authLogId, scopes },
  });
  if (!res.ok()) {
    throw new Error(
      `POST /api/auth/challenge: ${res.status()} ${(await res.text()).slice(0, 300)}`,
    );
  }
  const challenge = (await res.json()) as WalletChallengeEnvelope;
  return challenge;
}

export async function exchangeKs256ControlPlaneSession(opts: {
  request: HttpRequest;
  coordinatorUrl: string;
  authLogId: string;
  scopes: ControlPlaneScope[];
  privateKeyHex: string;
}): Promise<ControlPlaneSession> {
  const envelope = await postChallenge(
    opts.request,
    opts.coordinatorUrl,
    opts.authLogId,
    opts.scopes,
  );
  const account = privateKeyToAccount(
    normalizePrivateKeyHex(opts.privateKeyHex),
  );
  const message = buildControlPlaneMessage(envelope);
  const signature = await account.signMessage({ message });

  const sessionRes = await opts.request.post(
    `${opts.coordinatorUrl}/api/auth/session`,
    {
      headers: { "Content-Type": "application/json" },
      data: { envelope, signature, alg: "KS256" },
    },
  );
  if (!sessionRes.ok()) {
    throw new Error(
      `POST /api/auth/session (KS256): ${sessionRes.status()} ${(await sessionRes.text()).slice(0, 300)}`,
    );
  }
  return (await sessionRes.json()) as ControlPlaneSession;
}

async function signEs256ControlPlaneMessage(
  rootKeyPair: CryptoKeyPair,
  message: string,
): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      rootKeyPair.privateKey,
      new TextEncoder().encode(message),
    ),
  );
  return bytesToBase64(signature);
}

export async function exchangeEs256ControlPlaneSession(opts: {
  request: HttpRequest;
  coordinatorUrl: string;
  authLogId: string;
  scopes: ControlPlaneScope[];
  rootKeyPair: CryptoKeyPair;
}): Promise<ControlPlaneSession> {
  const envelope = await postChallenge(
    opts.request,
    opts.coordinatorUrl,
    opts.authLogId,
    opts.scopes,
  );
  const { x, y } = await exportEs256RootXy(opts.rootKeyPair);
  const message = buildControlPlaneMessage(envelope);
  const signature = await signEs256ControlPlaneMessage(
    opts.rootKeyPair,
    message,
  );

  const sessionRes = await opts.request.post(
    `${opts.coordinatorUrl}/api/auth/session`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        envelope,
        signature,
        alg: "ES256",
        publicKeyX: bytesToBase64(x),
        publicKeyY: bytesToBase64(y),
      },
    },
  );
  if (!sessionRes.ok()) {
    throw new Error(
      `POST /api/auth/session (ES256): ${sessionRes.status()} ${(await sessionRes.text()).slice(0, 300)}`,
    );
  }
  return (await sessionRes.json()) as ControlPlaneSession;
}

export async function postSigningRouteWithSession(opts: {
  request: HttpRequest;
  coordinatorUrl: string;
  logId: string;
  sessionToken: string;
  mode?: "wallet" | "http";
}): Promise<void> {
  const res = await opts.request.post(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/signing-route`,
    {
      headers: sessionAuthHeaders(opts.sessionToken, {
        "Content-Type": "application/json",
      }),
      data: { mode: opts.mode ?? "wallet" },
    },
  );
  if (!res.ok()) {
    throw new Error(
      `POST signing-route: ${res.status()} ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function getSigningRouteWithSession(opts: {
  request: HttpRequest;
  coordinatorUrl: string;
  logId: string;
  sessionToken: string;
}): Promise<{ mode: string }> {
  const res = await opts.request.get(
    `${opts.coordinatorUrl}/api/logs/${opts.logId}/signing-route`,
    {
      headers: sessionAuthHeaders(opts.sessionToken),
    },
  );
  if (!res.ok()) {
    throw new Error(
      `GET signing-route: ${res.status()} ${(await res.text()).slice(0, 300)}`,
    );
  }
  return (await res.json()) as { mode: string };
}

export const WALLET_CHALLENGE_KS256_SCOPES: ControlPlaneScope[] = [
  "delegations:read",
  "logs:signing-route:read",
  "logs:signing-route:write",
  "logs:enabled:read",
  "logs:enabled:write",
];

export const WALLET_CHALLENGE_ES256_SCOPES: ControlPlaneScope[] = [
  "delegations:read",
  "logs:signing-route:read",
  "logs:signing-route:write",
];

/** Operator public-root + wallet session + POST signing-route (ES256). */
export async function setupEs256WalletSigningRoute(opts: {
  request: HttpRequest;
  coordinatorUrl: string;
  appToken: string;
  logId: string;
  rootKeyPair: CryptoKeyPair;
}): Promise<ControlPlaneSession> {
  const { x, y } = await exportEs256RootXy(opts.rootKeyPair);
  const rootRes = await uploadByokRootPublicKey({
    coordinatorUrl: opts.coordinatorUrl,
    token: opts.appToken,
    logId: opts.logId,
    x,
    y,
  });
  if (rootRes.status !== 200) {
    throw new Error(
      `POST public-root (ES256): ${rootRes.status} ${(await rootRes.text()).slice(0, 300)}`,
    );
  }
  const session = await exchangeEs256ControlPlaneSession({
    request: opts.request,
    coordinatorUrl: opts.coordinatorUrl,
    authLogId: opts.logId,
    scopes: WALLET_CHALLENGE_ES256_SCOPES,
    rootKeyPair: opts.rootKeyPair,
  });
  await postSigningRouteWithSession({
    request: opts.request,
    coordinatorUrl: opts.coordinatorUrl,
    logId: opts.logId,
    sessionToken: session.token,
    mode: "wallet",
  });
  return session;
}

/** Operator public-root + wallet session + POST signing-route (KS256). */
export async function setupKs256WalletSigningRoute(opts: {
  request: HttpRequest;
  coordinatorUrl: string;
  appToken: string;
  logId: string;
  privateKeyHex: string;
  rootAddress: Uint8Array;
}): Promise<ControlPlaneSession> {
  const rootRes = await uploadBootstrapKs256PublicRoot({
    coordinatorUrl: opts.coordinatorUrl,
    token: opts.appToken,
    logId: opts.logId,
    address: opts.rootAddress,
  });
  if (rootRes.status !== 200) {
    throw new Error(
      `POST public-root (KS256): ${rootRes.status} ${(await rootRes.text()).slice(0, 300)}`,
    );
  }
  const session = await exchangeKs256ControlPlaneSession({
    request: opts.request,
    coordinatorUrl: opts.coordinatorUrl,
    authLogId: opts.logId,
    scopes: WALLET_CHALLENGE_ES256_SCOPES,
    privateKeyHex: opts.privateKeyHex,
  });
  await postSigningRouteWithSession({
    request: opts.request,
    coordinatorUrl: opts.coordinatorUrl,
    logId: opts.logId,
    sessionToken: session.token,
    mode: "wallet",
  });
  return session;
}
