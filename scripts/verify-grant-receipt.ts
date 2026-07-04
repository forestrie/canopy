#!/usr/bin/env node
/**
 * Offline grant receipt verification CLI (FOR-282 / ADR-0045).
 * No network during verify.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  decodeForestrieGrantCose,
  decodeGrantPayload,
  decodeGrantResponse,
  verifyGrantReceiptOffline,
} from "@forestrie/receipt-verify";

const { values } = parseArgs({
  options: {
    genesis: { type: "string" },
    receipt: { type: "string" },
    grant: { type: "string" },
    "grant-b64": { type: "string" },
    "grant-response": { type: "string" },
    "idtimestamp-be8": { type: "string" },
  },
});

function readBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function readOptionalBase64(b64: string | undefined): Uint8Array | null {
  if (!b64) return null;
  return new Uint8Array(Buffer.from(b64, "base64"));
}

async function main(): Promise<void> {
  const genesisPath = values.genesis;
  const receiptPath = values.receipt;
  if (!genesisPath || !receiptPath) {
    console.error(
      "Usage: verify-grant-receipt --genesis PATH --receipt PATH (--grant-b64 B64 | --grant PATH | --grant-response PATH) [--idtimestamp-be8 PATH]",
    );
    process.exit(2);
  }

  const genesisCbor = readBytes(genesisPath);
  const receiptCbor = readBytes(receiptPath);

  let grant;
  let idtimestampBe8: Uint8Array | null = null;

  const grantResponsePath = values["grant-response"];
  if (grantResponsePath) {
    const decoded = decodeGrantResponse(readBytes(grantResponsePath));
    grant = decoded.grant;
    idtimestampBe8 = decoded.idtimestamp;
  } else {
    const grantB64 = values["grant-b64"];
    const grantPath = values.grant;
    if (grantB64) {
      const bytes = readOptionalBase64(grantB64)!;
      try {
        const decoded = decodeForestrieGrantCose(bytes);
        grant = decoded.grant;
        idtimestampBe8 = decoded.idtimestampBe8;
      } catch {
        grant = decodeGrantPayload(bytes);
      }
    } else if (grantPath) {
      grant = decodeGrantPayload(readBytes(grantPath));
    } else {
      console.error("Missing --grant-b64, --grant, or --grant-response");
      process.exit(2);
    }
  }

  const idtimestampPath = values["idtimestamp-be8"];
  if (idtimestampPath) {
    idtimestampBe8 = readBytes(idtimestampPath);
  }
  if (!idtimestampBe8 || idtimestampBe8.length < 8) {
    console.error("Missing or invalid --idtimestamp-be8 (8 bytes required)");
    process.exit(2);
  }

  const result = await verifyGrantReceiptOffline({
    genesisCbor,
    receiptCbor,
    grant,
    idtimestampBe8,
  });

  if (!result.ok) {
    console.error(
      `verify failed: stage=${result.stage} reason=${result.reason ?? "unknown"}`,
    );
    process.exit(1);
  }
  console.log("ok");
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
