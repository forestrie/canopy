/**
 * Direct Custodian HTTP API e2e (`CUSTODIAN_URL` = ingress origin; ops at `/healthz`…,
 * API at `/v1/api/…` per Traefik stripPrefix).
 * Does not use `:bootstrap` key routes; curator must not resolve our random log to `:bootstrap`.
 */

import { expect, test, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  custodianKmsCryptoKeyIdFromLogUuid,
  e2eCustodianKeyOwnerId,
} from "./utils/custodian-custody-grant.js";
import {
  assertCustodianApiE2eEnv,
  custodianApiBootstrapAppToken,
  custodianApiV1BaseUrl,
  skipWithoutCustodianApi,
} from "./utils/custodian-api-env.js";
import { getCustodianApiCuratorLogKey } from "./utils/custodian-api-curator-log-key.js";
import { postCustodianApiCreateEs256Key } from "./utils/custodian-api-create-key.js";
import { postCustodianApiDeleteKey } from "./utils/custodian-api-delete-key.js";
import {
  getCustodianApiKeysListGet,
  postCustodianApiKeysList,
} from "./utils/custodian-api-keys-list.js";
import {
  getCustodianHealthz,
  getCustodianMetricsText,
  getCustodianReadyz,
  getCustodianVersionJson,
} from "./utils/custodian-api-ops.js";
import { getCustodianApiPublicKey } from "./utils/custodian-api-public-key.js";
import {
  postCustodianApiSignPayload,
  verifyCustodianApiSign1AgainstPem,
} from "./utils/custodian-api-sign.js";

test.describe.configure({ mode: "serial" });

type RunState = {
  baseUrl: string;
  appToken: string;
  /** KMS CryptoKey id segment (32 lowercase hex); safe in URL paths (no `/`). */
  cryptoKeyShortId: string;
  logHex32: string;
};

let run: RunState | undefined;

function skipIfNoBootstrap(testInfo: TestInfo): void {
  if (!custodianApiBootstrapAppToken()) {
    testInfo.skip(
      true,
      "Set CUSTODIAN_BOOTSTRAP_APP_TOKEN to run custody key teardown (POST /v1/api/keys/{id}/delete).",
    );
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test.describe("Custodian HTTP API (deployed)", () => {
  test.beforeEach(({}, testInfo) => {
    skipWithoutCustodianApi(testInfo);
  });

  test("ops smoke, create, public, sign, curator, list, log-id public", async () => {
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

    const selfLogId = randomUUID();
    const logHex32 = custodianKmsCryptoKeyIdFromLogUuid(selfLogId);
    const keyOwnerId = e2eCustodianKeyOwnerId();

    const created = await postCustodianApiCreateEs256Key({
      baseUrl,
      appToken,
      body: {
        keyOwnerId,
        selfLogId,
        alg: "ES256",
      },
    });
    expect(created.alg).toBe("ES256");
    expect(created.keyId).not.toBe(":bootstrap");
    expect(created.publicKeyPem).toContain("BEGIN PUBLIC KEY");

    const pub = await getCustodianApiPublicKey({
      baseUrl,
      // KMS CryptoKey id is selfLogId (32 hex), same segment as sign — not keyOwnerId.
      keyIdSegment: logHex32,
    });
    expect(pub.publicKeyPem.trim()).toBe(created.publicKeyPem.trim());
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
      verifyCustodianApiSign1AgainstPem(sign1, created.publicKeyPem),
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
    // Curator CBOR returns short CryptoKey id; create response keyId may be full GCP resource name.
    expect(curatorKeyId).toBe(logHex32);

    const listedGet = await getCustodianApiKeysListGet({
      baseUrl,
      appToken,
      labels: { "fo-log_id": logHex32 },
      predicate: "and",
    });
    expect(
      listedGet.keys.some(
        (e) => e.keyId === created.keyId || e.keyId.endsWith(logHex32),
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
        (e) => e.keyId === created.keyId || e.keyId.endsWith(logHex32),
      ),
    ).toBeTruthy();

    // Curator/log-key exercises `?log-id=true`; public above uses the KMS short id (selfLogId).

    run = {
      baseUrl,
      appToken,
      cryptoKeyShortId: logHex32,
      logHex32,
    };
  });

  test("teardown: delete custody key (bootstrap app token)", async ({}, testInfo) => {
    skipWithoutCustodianApi(testInfo);
    skipIfNoBootstrap(testInfo);
    const state = run;
    if (!state) {
      testInfo.skip(true, "Previous Custodian API test did not complete.");
      return;
    }
    const bootstrap = custodianApiBootstrapAppToken()!;

    const del = await postCustodianApiDeleteKey({
      baseUrl: state.baseUrl,
      bootstrapAppToken: bootstrap,
      keyIdSegment: state.cryptoKeyShortId,
    });
    expect(del.destroyedCount).toBeGreaterThanOrEqual(1);

    const v1 = custodianApiV1BaseUrl(state.baseUrl);
    const gone = await fetch(
      `${v1}/api/keys/${encodeURIComponent(state.cryptoKeyShortId)}/public`,
      { headers: { Accept: "application/cbor" } },
    );
    expect(gone.status).toBe(404);

    // KMS list-by-label can still include a CryptoKey while versions are
    // DESTROY_SCHEDULED; do not assert immediate absence from list.

    run = undefined;
  });
});
