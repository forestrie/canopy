/**
 * RCA helpers for auth-data-log-chain parent grant artifacts (plan-0026).
 * Used to attach evidence on failure; safe to keep for e2e debugging.
 */

import { decodeCborDeterministic as decodeCbor } from "@forestrie/encoding";
import { extractDelegationCertBytes } from "@e2e-canopy-api-src/grant/delegation-verify.js";
import {
  HEADER_FORESTRIE_GRANT_V0,
  HEADER_IDTIMESTAMP,
  HEADER_RECEIPT,
} from "@e2e-canopy-api-src/grant/transparent-statement.js";
import { parseReceipt } from "@e2e-canopy-api-src/grant/receipt-verify.js";
import {
  decodeEntryIdHex,
  entryIdHexToIdtimestampBe8,
} from "./entry-id-e2e.js";
import { base64ToBytes } from "./bootstrap-grant-flow.js";

export interface ParentGrantReceiptDiagnostic {
  hasReceiptHeader: boolean;
  hasIdtimestampHeader: boolean;
  receiptByteLength: number;
  hasDelegationCert: boolean;
  proofMmrIndex: string | null;
  idtimestampMatchesEntryId: boolean;
  receiptMatchesResolveReceiptBody: boolean;
}

export function diagnoseCompletedParentGrant(opts: {
  completedGrantBase64: string;
  resolveReceiptBody: Uint8Array;
  entryIdHex: string;
}): ParentGrantReceiptDiagnostic {
  const grantBytes = base64ToBytes(opts.completedGrantBase64);
  const sign1 = decodeCbor(grantBytes) as unknown[];
  const unprot =
    sign1[1] instanceof Map
      ? (sign1[1] as Map<number, unknown>)
      : new Map<number, unknown>(
          Object.entries(sign1[1] as Record<string, unknown>).map(([k, v]) => [
            Number(k),
            v,
          ]),
        );
  const receiptVal = unprot.get(HEADER_RECEIPT);
  const idtsVal = unprot.get(HEADER_IDTIMESTAMP);
  const hasReceipt = receiptVal instanceof Uint8Array && receiptVal.length > 0;
  const hasIdts = idtsVal instanceof Uint8Array && idtsVal.length >= 8;

  let hasDelegationCert = false;
  let proofMmrIndex: string | null = null;
  let receiptMatchesResolveReceiptBody = false;

  if (hasReceipt) {
    const parsed = parseReceipt(receiptVal);
    hasDelegationCert = extractDelegationCertBytes(parsed.coseSign1[1]) != null;
    proofMmrIndex = parsed.proof.mmrIndex?.toString() ?? null;
    if (receiptVal.length === opts.resolveReceiptBody.length) {
      receiptMatchesResolveReceiptBody = receiptVal.every(
        (b, i) => b === opts.resolveReceiptBody[i],
      );
    }
  }

  let idtimestampMatchesEntryId = false;
  if (hasIdts) {
    const expected = entryIdHexToIdtimestampBe8(opts.entryIdHex);
    const idts =
      idtsVal instanceof Uint8Array && idtsVal.length === 8
        ? idtsVal
        : idtsVal instanceof Uint8Array
          ? idtsVal.slice(-8)
          : new Uint8Array(8);
    idtimestampMatchesEntryId = idts.every((b, i) => b === expected[i]);
  }

  const embedded = unprot.get(HEADER_FORESTRIE_GRANT_V0);
  if (!(embedded instanceof Uint8Array) || embedded.length === 0) {
    throw new Error("completed parent grant missing embedded grant v0");
  }

  const { mmrIndex } = decodeEntryIdHex(opts.entryIdHex);

  return {
    hasReceiptHeader: hasReceipt,
    hasIdtimestampHeader: hasIdts,
    receiptByteLength: hasReceipt ? receiptVal.length : 0,
    hasDelegationCert,
    proofMmrIndex: proofMmrIndex ?? mmrIndex.toString(),
    idtimestampMatchesEntryId,
    receiptMatchesResolveReceiptBody,
  };
}
