import { expect } from "vitest";
import { mintSessionToken } from "../../src/auth/wallet-challenge/session-token.js";
import type { ControlPlaneScope } from "../../src/types/control-plane-scope.js";

const SESSION_SECRET = "test-wallet-challenge-secret";

export function mintTestSessionToken(opts: {
  authLogIdHex32: string;
  scopes: ControlPlaneScope[];
}): string {
  const { token } = mintSessionToken(
    {
      authLogId: opts.authLogIdHex32,
      scopes: opts.scopes,
      aud: "http://localhost",
    },
    SESSION_SECRET,
  );
  return token;
}

export function sessionHeaders(
  token: string,
  extra?: HeadersInit,
): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

export function enabledResponse(
  enabled: boolean,
  opts?: { userEnabled?: boolean; operatorEnabled?: boolean },
): {
  enabled: boolean;
  userEnabled: boolean;
  operatorEnabled: boolean;
} {
  return {
    enabled,
    userEnabled: opts?.userEnabled ?? true,
    operatorEnabled: opts?.operatorEnabled ?? enabled,
  };
}

export function expectEnabledBody(
  body: unknown,
  enabled: boolean,
  opts?: { userEnabled?: boolean; operatorEnabled?: boolean },
): void {
  expect(body).toEqual(enabledResponse(enabled, opts));
}
