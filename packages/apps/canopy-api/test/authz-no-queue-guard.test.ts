/**
 * Guard (plan-0025): authorization must not depend on SequencingQueue Durable Object
 * state. The grant-authorization modules must never resolve queue content
 * (`resolveContent`) nor import the retired `verify-grant-inclusion` primitive.
 *
 * `resolveContent` remains legitimate for NON-authorization use:
 * query-registration-status (polling) and grant-sequencing (enqueue dedupe).
 */

import { describe, expect, it } from "vitest";
import authGrantSrc from "../src/scrapi/auth-grant.ts?raw";
import registerGrantSrc from "../src/scrapi/register-grant.ts?raw";
import registerSignedStatementSrc from "../src/scrapi/register-signed-statement.ts?raw";

const AUTHZ_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ["auth-grant.ts", authGrantSrc],
  ["register-grant.ts", registerGrantSrc],
  ["register-signed-statement.ts", registerSignedStatementSrc],
];

const FORBIDDEN = [
  "resolveContent",
  "verifyGrantIncluded",
  "verify-grant-inclusion",
];

describe("authorization is queue-state-independent (plan-0025 guard)", () => {
  for (const [name, src] of AUTHZ_SOURCES) {
    for (const needle of FORBIDDEN) {
      it(`${name} does not reference ${needle}`, () => {
        expect(src.includes(needle)).toBe(false);
      });
    }
  }
});
