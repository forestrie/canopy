/**
 * register-signed-statement under ADR-0065 §4: endorsed session-key
 * admission (plan-2608-14 2.1 / 2.3, Q12 gate 1).
 *
 * canopy SCRAPI admission is THE leaf-signer enforcement point. When a leaf
 * carries a session-key endorsement at unprotected label -65801, the (kid
 * binding, verify key) pair is resolved from that endorsement — verified
 * under the grant's `grantData` root, UV per `GF_REQUIRES_USER_VERIFICATION`,
 * window against canopy's clock — and never from `grantData` directly. A
 * present-but-invalid endorsement is a 403 with a distinct reason and never
 * falls back. Without -65801 nothing changes (4a-rooted logs, custodian
 * bootstrap statements).
 *
 * Drives the real worker (`worker.fetch`) like scrapi-flow.test.ts: admitted
 * = 303 (queue bound) or the post-verification 503 naming SEQUENCING_QUEUE;
 * every rejection is a 4xx problem-details body.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  COSE_LABEL_SESSION_KEY_ENDORSEMENT,
  WEBAUTHN_ENVELOPE_LABEL,
  encodeCborDeterministic,
} from "@forestrie/encoding";
import {
  buildSessionKeyEndorsementTbs,
  SESSION_KEY_ENDORSEMENT_CONTENT_TYPE,
  SESSION_KEY_ENDORSEMENT_V1_CONTENT_TYPE,
} from "@forestrie/receipt-verify";
import worker from "../src/index";
import type { Env } from "../src/index";
import type { Grant } from "../src/grant";
import { uuidToBytes } from "../src/grant";
import { custodianStatementKidFromXyGrantData } from "../src/grant/custodian-statement-kid.js";
import { decodeCborAsObject } from "./helpers/cbor-decode-object.js";
import { forestrieGrantAuthorizationHeader } from "./helpers/custodian-transparent-grant";
import {
  seedGenesisChainIdentity,
  validGenesisV2Es256CborMap,
} from "./helpers/genesis-v2-body.js";
import { mintTestOnboardToken } from "./helpers/onboard-token.js";
import {
  buildEndorsement,
  buildVariantEndorsement,
  exportXy,
  FLAG_UP,
  FLAG_UV,
  generateP256,
  signEndorsedStatement,
  signStatement,
  windowAround,
} from "./helpers/endorsed-statement.js";

const testEnv = env as unknown as Env;

const DATA_LOG_ID = "de305d54-75b4-431b-adb2-eb6b9e546014";
const OWNER_LOG_ID = "660e8400-e29b-41d4-a716-446655440001";

let bootstrapLogId = "";
/** The passkey root: grantData = root x‖y = on-chain logRootKey. */
let root: CryptoKeyPair;
let rootXy: Uint8Array;
/** The endorsed WebCrypto session key that signs per-turn leaves. */
let session: CryptoKeyPair;
let sessionXy: Uint8Array;
let idtimestampSeq = 100;

beforeAll(async () => {
  root = await generateP256();
  rootXy = await exportXy(root.publicKey);
  session = await generateP256();
  sessionXy = await exportXy(session.publicKey);

  bootstrapLogId = crypto.randomUUID();
  const { token } = await mintTestOnboardToken(testEnv, "endorsed-admission");
  await seedGenesisChainIdentity(
    testEnv,
    validGenesisV2Es256CborMap({ bootstrapKey: rootXy }),
  );
  const genesisBody = encodeCborDeterministic(
    validGenesisV2Es256CborMap({ bootstrapKey: rootXy }),
  ) as Uint8Array;
  const res = await worker.fetch(
    new Request(`http://localhost/api/forest/${bootstrapLogId}/genesis`, {
      method: "POST",
      headers: {
        "Content-Type": "application/cbor",
        Authorization: `Bearer ${token}`,
      },
      body: genesisBody,
    }),
    testEnv,
    {} as ExecutionContext,
  );
  expect(res.status).toBe(201);
});

/** Data-log statement grant rooted at `grantData` (byte 2 carries UV). */
function dataLogGrant(grantData: Uint8Array, opts?: { uv?: boolean }): Grant {
  const flags = new Uint8Array(8);
  flags[3] = 0x03; // GF_CREATE | GF_EXTEND
  flags[7] = 0x02; // GF_DATA_LOG
  if (opts?.uv) flags[2] |= 0x01; // GF_REQUIRES_USER_VERIFICATION
  return {
    logId: uuidToBytes(DATA_LOG_ID),
    ownerLogId: uuidToBytes(OWNER_LOG_ID),
    grant: flags,
    maxHeight: 0,
    minGrowth: 0,
    grantData,
  };
}

async function postStatement(
  grant: Grant,
  statement: Uint8Array,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  // The grant envelope is signed by the ROOT under the custodian profile
  // (the same shape scrapi-flow uses); it is authorised by inclusion, and
  // its signer is irrelevant to the statement-signer rules under test.
  const authHeader = await forestrieGrantAuthorizationHeader(
    grant,
    root.privateKey,
    custodianStatementKidFromXyGrantData(rootXy),
    new Uint8Array(8).fill(idtimestampSeq++ & 0xff),
  );
  const response = await worker.fetch(
    new Request(`http://localhost/register/${bootstrapLogId}/entries`, {
      method: "POST",
      headers: {
        "content-type": 'application/cose; cose-type="cose-sign1"',
        Authorization: authHeader,
      },
      body: statement,
    }),
    testEnv,
    {} as ExecutionContext,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const body =
    bytes.length > 0
      ? (decodeCborAsObject(bytes) as Record<string, unknown>)
      : null;
  return { status: response.status, body };
}

/** Admitted = enqueued (303) or the post-verification 503 (queue unbound). */
function expectAdmitted(r: {
  status: number;
  body: Record<string, unknown> | null;
}): void {
  expect([303, 503]).toContain(r.status);
  if (r.status === 503) {
    expect(String(r.body?.detail ?? "")).toContain("SEQUENCING_QUEUE");
  }
}

function expectForbidden(
  r: { status: number; body: Record<string, unknown> | null },
  reason: string,
): void {
  expect(r.status).toBe(403);
  expect(r.body?.reason).toBe(reason);
}

describe("register-signed-statement: endorsed session-key admission (ADR-0065 §4)", () => {
  it("admits a leaf signed by the endorsed session key (kid = session x, -65801 under grantData)", async () => {
    const endorsement = await buildEndorsement(
      root,
      sessionXy,
      windowAround(Date.now()),
    );
    const statement = await signEndorsedStatement(session, endorsement);
    expectAdmitted(await postStatement(dataLogGrant(rootXy), statement));
  });

  it("rejects an endorsement under a different root → endorsement_root_mismatch", async () => {
    const impostor = await generateP256();
    const endorsement = await buildEndorsement(
      impostor,
      sessionXy,
      windowAround(Date.now()),
    );
    const statement = await signEndorsedStatement(session, endorsement);
    expectForbidden(
      await postStatement(dataLogGrant(rootXy), statement),
      "endorsement_root_mismatch",
    );
  });

  it("rejects an endorsement whose kid names a key other than grantData (artifact confusion) → endorsement_root_mismatch", async () => {
    const other = await generateP256();
    const otherXy = await exportXy(other.publicKey);
    // Signed by the real root, but the signed kid is someone else's x.
    const tbs = buildSessionKeyEndorsementTbs({
      rootPublicKeyX: otherXy.slice(0, 32),
      sessionPublicKeyXY: sessionXy,
      ...windowAround(Date.now()),
    });
    const endorsement = await buildEndorsement(
      root,
      sessionXy,
      windowAround(Date.now()),
      { tbsOverride: tbs },
    );
    const statement = await signEndorsedStatement(session, endorsement);
    expectForbidden(
      await postStatement(dataLogGrant(rootXy), statement),
      "endorsement_root_mismatch",
    );
  });

  it("present-but-invalid never falls back: a root-signed, root-kid leaf carrying garbage at -65801 is refused", async () => {
    // Without the -65801 entry this exact statement is admissible under
    // grantData. With an unusable entry present, admission must not quietly
    // take the grantData route.
    for (const garbage of [
      new Uint8Array(64).fill(0xee), // bstr that is not a COSE Sign1
      new Uint8Array(0), // empty bstr
      1234, // not a bstr at all
      "endorsement", // text
      [new Uint8Array(37), new Uint8Array(2)], // an envelope-shaped array
    ]) {
      const statement = await signStatement(
        root,
        rootXy.slice(0, 32),
        new Map<number, unknown>([
          [COSE_LABEL_SESSION_KEY_ENDORSEMENT, garbage],
        ]),
      );
      expectForbidden(
        await postStatement(dataLogGrant(rootXy), statement),
        "endorsement_invalid",
      );
    }
  });

  it("rejects a v1 (window-less) endorsement → endorsement_invalid (not grandfathered)", async () => {
    const v1 = await buildVariantEndorsement(
      root,
      new Map<number, unknown>([
        [1, -65800],
        [3, SESSION_KEY_ENDORSEMENT_V1_CONTENT_TYPE],
        [4, rootXy.slice(0, 32)],
      ]),
      encodeCborDeterministic(
        new Map<string, unknown>([["sessionKey", sessionXy]]),
      ),
    );
    const statement = await signEndorsedStatement(session, v1);
    expectForbidden(
      await postStatement(dataLogGrant(rootXy), statement),
      "endorsement_invalid",
    );
  });

  it("window: expired, not yet valid, and malformed all → endorsement_expired; a notBefore within skew is admitted", async () => {
    const now = Date.now();
    const expired = await buildEndorsement(
      root,
      sessionXy,
      windowAround(now, { notBefore: now - 10_000_000, notAfter: now - 1000 }),
    );
    expectForbidden(
      await postStatement(
        dataLogGrant(rootXy),
        await signEndorsedStatement(session, expired),
      ),
      "endorsement_expired",
    );

    const notYet = await buildEndorsement(
      root,
      sessionXy,
      windowAround(now, { notBefore: now + 60 * 60 * 1000 }),
    );
    expectForbidden(
      await postStatement(
        dataLogGrant(rootXy),
        await signEndorsedStatement(session, notYet),
      ),
      "endorsement_expired",
    );

    const malformed = await buildVariantEndorsement(
      root,
      new Map<number, unknown>([
        [1, -65800],
        [3, SESSION_KEY_ENDORSEMENT_CONTENT_TYPE],
        [4, rootXy.slice(0, 32)],
      ]),
      encodeCborDeterministic(
        new Map<string, unknown>([
          ["sessionKey", sessionXy],
          ["notBefore", now],
          ["notAfter", now - 1],
        ]),
      ),
    );
    expectForbidden(
      await postStatement(
        dataLogGrant(rootXy),
        await signEndorsedStatement(session, malformed),
      ),
      "endorsement_expired",
    );

    // A browser clock a minute fast is tolerated (skew), not rejected.
    const slightlyAhead = await buildEndorsement(
      root,
      sessionXy,
      windowAround(now, { notBefore: now + 60_000 }),
    );
    expectAdmitted(
      await postStatement(
        dataLogGrant(rootXy),
        await signEndorsedStatement(session, slightlyAhead),
      ),
    );
  });

  it("UV is governed by the grant flag: GF_REQUIRES_USER_VERIFICATION + UP-only → endorsement_uv_required", async () => {
    const upOnly = await buildEndorsement(
      root,
      sessionXy,
      windowAround(Date.now()),
      { flags: FLAG_UP },
    );
    const upUv = await buildEndorsement(
      root,
      sessionXy,
      windowAround(Date.now()),
      { flags: FLAG_UP | FLAG_UV },
    );
    expectForbidden(
      await postStatement(
        dataLogGrant(rootXy, { uv: true }),
        await signEndorsedStatement(session, upOnly),
      ),
      "endorsement_uv_required",
    );
    expectAdmitted(
      await postStatement(
        dataLogGrant(rootXy, { uv: true }),
        await signEndorsedStatement(session, upUv),
      ),
    );
    // No flag on the grant: UP alone suffices (ADR-0063 §4).
    expectAdmitted(
      await postStatement(
        dataLogGrant(rootXy),
        await signEndorsedStatement(session, upOnly),
      ),
    );
  });

  it("rejects a -65800 entry on a leaf — the envelope label is never an endorsement", async () => {
    // Endorsed leaf that ALSO carries a -65800 entry: the plain-ES256 verify
    // branch fails closed on it (never ignored, never read as an endorsement).
    const endorsement = await buildEndorsement(
      root,
      sessionXy,
      windowAround(Date.now()),
    );
    const smuggled = await signEndorsedStatement(
      session,
      endorsement,
      new Map([
        [WEBAUTHN_ENVELOPE_LABEL, [new Uint8Array(37), new Uint8Array(2)]],
      ]),
    );
    const r = await postStatement(dataLogGrant(rootXy), smuggled);
    expect(r.status).toBe(400);

    // And a root-signed leaf with ONLY -65800 stays a 400 under grantData.
    const plainSmuggled = await signStatement(
      root,
      rootXy.slice(0, 32),
      new Map<number, unknown>([
        [WEBAUTHN_ENVELOPE_LABEL, [new Uint8Array(37), new Uint8Array(2)]],
      ]),
    );
    expect(
      (await postStatement(dataLogGrant(rootXy), plainSmuggled)).status,
    ).toBe(400);
  });

  it("under an endorsement the kid must be the session x — root kid is signer_mismatch, custodian 16-byte kid is not consulted", async () => {
    const endorsement = await buildEndorsement(
      root,
      sessionXy,
      windowAround(Date.now()),
    );
    const rootKid = await signStatement(
      session,
      rootXy.slice(0, 32),
      new Map<number, unknown>([
        [COSE_LABEL_SESSION_KEY_ENDORSEMENT, endorsement],
      ]),
    );
    expectForbidden(
      await postStatement(dataLogGrant(rootXy), rootKid),
      "signer_mismatch",
    );
    const custodianKid = await signStatement(
      root,
      custodianStatementKidFromXyGrantData(rootXy),
      new Map<number, unknown>([
        [COSE_LABEL_SESSION_KEY_ENDORSEMENT, endorsement],
      ]),
    );
    expectForbidden(
      await postStatement(dataLogGrant(rootXy), custodianKid),
      "signer_mismatch",
    );
  });

  it("a valid endorsement does not admit a leaf signed by some other key claiming the session kid", async () => {
    const attacker = await generateP256();
    const endorsement = await buildEndorsement(
      root,
      sessionXy,
      windowAround(Date.now()),
    );
    const forged = await signStatement(
      attacker,
      sessionXy.slice(0, 32),
      new Map<number, unknown>([
        [COSE_LABEL_SESSION_KEY_ENDORSEMENT, endorsement],
      ]),
    );
    expect((await postStatement(dataLogGrant(rootXy), forged)).status).toBe(
      400,
    );
  });

  it("no endorsement: the grantData path is unchanged (4a-rooted and custodian-kid leaves admitted; a bare session-signed leaf is still signer_mismatch)", async () => {
    // 4a custody: the session key IS the root.
    const rooted = await signStatement(root, rootXy.slice(0, 32), new Map());
    expectAdmitted(await postStatement(dataLogGrant(rootXy), rooted));

    // Custodian bootstrap profile: 16-byte kid, still honoured without -65801.
    const custodian = await signStatement(
      root,
      custodianStatementKidFromXyGrantData(rootXy),
      new Map(),
    );
    expectAdmitted(await postStatement(dataLogGrant(rootXy), custodian));

    // The pre-ADR-0065 live failure, still correct: an un-endorsed
    // session-signed leaf has no route to admission.
    const bare = await signStatement(
      session,
      sessionXy.slice(0, 32),
      new Map(),
    );
    expectForbidden(
      await postStatement(dataLogGrant(rootXy), bare),
      "signer_mismatch",
    );
  });
});
