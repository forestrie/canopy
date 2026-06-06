/**
 * Direct Custodian HTTP API e2e (`CUSTODIAN_URL` = ingress origin; ops at `/healthz`…,
 * API at `/v1/api/…` per Traefik stripPrefix).
 * Uses a static log id (reuse-safe); static custody key is not deleted on teardown.
 */

import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { custodianKmsCryptoKeyIdFromLogUuid } from "@e2e-utils/custodian-custody-grant.js";
import {
  assertCustodianApiE2eEnv,
  custodianApiV1BaseUrl,
} from "@e2e-utils/custodian-api-env.js";
import { postCustodianApiEnsureEs256Key } from "@e2e-utils/custodian-api-ensure-key.js";
import { getCustodianApiCuratorLogKey } from "@e2e-utils/custodian-api-curator-log-key.js";
import {
  getCustodianApiKeysListGet,
  postCustodianApiKeysList,
} from "@e2e-utils/custodian-api-keys-list.js";
import {
  getCustodianHealthz,
  getCustodianMetricsText,
  getCustodianReadyz,
  getCustodianVersionJson,
} from "@e2e-utils/custodian-api-ops.js";
import { getCustodianApiPublicKey } from "@e2e-utils/custodian-api-public-key.js";
import {
  postCustodianApiSignPayload,
  verifyCustodianApiSign1AgainstPem,
} from "@e2e-utils/custodian-api-sign.js";
import {
  E2E_STATIC_CUSTODIAN_API_LOG_ID,
  e2eStaticCustodianKeyLabels,
} from "@e2e-utils/e2e-static-log-ids.js";

test.describe.configure({ mode: "serial" });

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test.describe("Custodian HTTP API (deployed)", () => {
  test.beforeEach(() => {
    assertCustodianApiE2eEnv();
  });

  test("ops smoke, ensure, public, sign, curator, list", async () => {
    const { baseUrl, appToken } = assertCustodianApiE2eEnv();

    const hz = await getCustodianHealthz(baseUrl);
    expect(hz.status).toBe(200);
    expect(hz.text.trim()).toBe("ok");

    const rz = await getCustodianReadyz(baseUrl);
    expect(rz.status).toBe(200);
    expect(rz.text.trim()).toBe("ready");

    const ver = await getCustodianVersionJson(baseUrl);
    expect(ver.status).toBe(200);
    expect(ver.json?.version).toBeTruthy();

    const met = await getCustodianMetricsText(baseUrl);
    expect(met.status).toBe(200);
    expect(met.text.length).toBeGreaterThan(0);

    const selfLogId = E2E_STATIC_CUSTODIAN_API_LOG_ID;
    const logHex32 = custodianKmsCryptoKeyIdFromLogUuid(selfLogId);
    const keyOwnerId = logHex32;

    const ensured = await postCustodianApiEnsureEs256Key({
      baseUrl,
      appToken,
      body: {
        keyOwnerId,
        selfLogId,
        alg: "ES256",
        protectionLevel: "SOFTWARE",
        labels: e2eStaticCustodianKeyLabels(),
      },
    });
    expect(ensured.alg).toBe("ES256");
    expect(ensured.keyId).not.toBe(":bootstrap");
    expect(ensured.publicKeyPem).toContain("BEGIN PUBLIC KEY");

    const pub = await getCustodianApiPublicKey({
      baseUrl,
      keyIdSegment: logHex32,
    });
    expect(pub.publicKeyPem.trim()).toBe(ensured.publicKeyPem.trim());
    expect(pub.alg).toBe("ES256");

    const payloadBytes = new TextEncoder().encode(
      `custodian-api-e2e sign ${randomUUID()}`,
    );
    const sign1 = await postCustodianApiSignPayload({
      baseUrl,
      appToken,
      keyIdSegment: logHex32,
      payloadBytes,
    });
    expect(sign1.length).toBeGreaterThan(32);
    await expect(
      verifyCustodianApiSign1AgainstPem(sign1, ensured.publicKeyPem),
    ).resolves.toBe(true);

    let curatorKeyId: string | null = null;
    for (let i = 0; i < 40; i++) {
      const cur = await getCustodianApiCuratorLogKey({
        baseUrl,
        appToken,
        logId: logHex32,
      });
      if (cur.status === 200 && cur.keyId) {
        curatorKeyId = cur.keyId;
        break;
      }
      if (cur.status !== 404) {
        throw new Error(
          `Custodian curator/log-key: unexpected ${cur.status} for logId=${logHex32}`,
        );
      }
      await sleep(500);
    }
    expect(curatorKeyId).toBeTruthy();
    expect(curatorKeyId).not.toBe(":bootstrap");
    expect(curatorKeyId).toBe(logHex32);

    const listedGet = await getCustodianApiKeysListGet({
      baseUrl,
      appToken,
      labels: { "fo-log_id": logHex32 },
      predicate: "and",
    });
    expect(
      listedGet.keys.some(
        (e) => e.keyId === ensured.keyId || e.keyId.endsWith(logHex32),
      ),
    ).toBeTruthy();

    const listedPost = await postCustodianApiKeysList({
      baseUrl,
      appToken,
      labels: { "fo-log_id": logHex32 },
      predicate: "and",
    });
    expect(
      listedPost.keys.some(
        (e) => e.keyId === ensured.keyId || e.keyId.endsWith(logHex32),
      ),
    ).toBeTruthy();

    void custodianApiV1BaseUrl(baseUrl);
  });
});
