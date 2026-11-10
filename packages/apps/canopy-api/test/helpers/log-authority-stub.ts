/**
 * Log authority stubs for tests that drive admission through the
 * {@link LogAuthorityReader} seam rather than univocity over HTTP.
 */

import type { LogAuthority } from "../../src/env/log-authority.js";
import type { LogAuthorityReader } from "../../src/env/log-authority-reader.js";

/** A final anchored answer with a dummy ES256 key. */
export const ANCHORED_AUTHORITY: LogAuthority = {
  kind: "anchored",
  final: true,
  alg: -7,
  key: new Uint8Array(64),
};

/**
 * A reader whose reads take the next answer in turn, repeating the last, and
 * record the log id (lower hex) each read asked about.
 */
export function readerAnswering(...answers: LogAuthority[]): {
  reader: LogAuthorityReader;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      read: async (logId) => {
        asked.push(
          Array.from(logId, (b) => b.toString(16).padStart(2, "0")).join(""),
        );
        return answers.length > 1 ? answers.shift()! : answers[0]!;
      },
    },
  };
}

/** A reader that answers every log as anchored. */
export function anchoredReader(): LogAuthorityReader {
  return readerAnswering(ANCHORED_AUTHORITY).reader;
}
