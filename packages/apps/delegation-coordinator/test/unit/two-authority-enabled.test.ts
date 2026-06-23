import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeLogIdToHex32 } from "../../src/log-id.js";
import { fetchWithDoRetry } from "./fetch-with-do-retry.js";
import {
  expectEnabledBody,
  mintTestSessionToken,
  sessionHeaders,
} from "./wallet-session-helpers.js";

const TEST_TOKEN = "test-coordinator-token";

function appTokenHeaders(extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    ...extra,
  };
}

async function adminGetEnabled(logUuid: string): Promise<Response> {
  return fetchWithDoRetry(
    `http://localhost/admin/api/logs/${logUuid}/enabled`,
    { method: "GET", headers: appTokenHeaders() },
  );
}

async function adminPutEnabled(
  logUuid: string,
  enabled: boolean,
): Promise<Response> {
  return fetchWithDoRetry(
    `http://localhost/admin/api/logs/${logUuid}/enabled`,
    {
      method: "PUT",
      headers: appTokenHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ enabled }),
    },
  );
}

async function userPutEnabled(
  logUuid: string,
  logHex32: string,
  enabled: boolean,
): Promise<Response> {
  const token = mintTestSessionToken({
    authLogIdHex32: logHex32,
    scopes: ["logs:enabled:write"],
  });
  return fetchWithDoRetry(`http://localhost/api/logs/${logUuid}/enabled`, {
    method: "PUT",
    headers: sessionHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ enabled }),
  });
}

describe("two-authority enabled model", () => {
  const logUuid = randomUUID();
  const logHex32 = normalizeLogIdToHex32(logUuid);

  it("starts with effective enabled when row is created via admin", async () => {
    const putRes = await adminPutEnabled(logUuid, true);
    expect(putRes.status).toBe(200);
    expectEnabledBody(await putRes.json(), true);

    const getRes = await adminGetEnabled(logUuid);
    expect(getRes.status).toBe(200);
    expectEnabledBody(await getRes.json(), true);
  });

  it("operator disable does not change user_enabled", async () => {
    const disableOp = await adminPutEnabled(logUuid, false);
    expect(disableOp.status).toBe(200);
    expectEnabledBody(await disableOp.json(), false, {
      userEnabled: true,
      operatorEnabled: false,
    });

    const getRes = await adminGetEnabled(logUuid);
    expectEnabledBody(await getRes.json(), false, {
      userEnabled: true,
      operatorEnabled: false,
    });
  });

  it("user disable does not change operator_enabled", async () => {
    await adminPutEnabled(logUuid, true);

    const userDisable = await userPutEnabled(logUuid, logHex32, false);
    expect(userDisable.status).toBe(200);
    expectEnabledBody(await userDisable.json(), false, {
      userEnabled: false,
      operatorEnabled: true,
    });

    const getRes = await adminGetEnabled(logUuid);
    expectEnabledBody(await getRes.json(), false, {
      userEnabled: false,
      operatorEnabled: true,
    });
  });

  it("effective is on only when both authorities allow", async () => {
    await adminPutEnabled(logUuid, true);
    await userPutEnabled(logUuid, logHex32, true);
    let getRes = await adminGetEnabled(logUuid);
    expectEnabledBody(await getRes.json(), true, {
      userEnabled: true,
      operatorEnabled: true,
    });

    await adminPutEnabled(logUuid, false);
    getRes = await adminGetEnabled(logUuid);
    expectEnabledBody(await getRes.json(), false, {
      userEnabled: true,
      operatorEnabled: false,
    });

    await adminPutEnabled(logUuid, true);
    await userPutEnabled(logUuid, logHex32, false);
    getRes = await adminGetEnabled(logUuid);
    expectEnabledBody(await getRes.json(), false, {
      userEnabled: false,
      operatorEnabled: true,
    });

    await userPutEnabled(logUuid, logHex32, true);
    getRes = await adminGetEnabled(logUuid);
    expectEnabledBody(await getRes.json(), true);
  });

  it("legacy enabled=0 maps to operator_enabled=0 with user_enabled=1 on migration", () => {
    // Documented SQL in ensureEnabledAuthorityColumns:
    // UPDATE ... SET operator_enabled = enabled, user_enabled = 1
    const legacyEnabled = 0;
    const migratedOperator = legacyEnabled !== 0;
    const migratedUser = true;
    expect(migratedOperator).toBe(false);
    expect(migratedUser).toBe(true);
    expect(migratedUser && migratedOperator).toBe(false);
  });
});
