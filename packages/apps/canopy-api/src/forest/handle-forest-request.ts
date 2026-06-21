/**
 * `/api/forest/**` dispatcher. POST genesis: onboard token or endorsement grant.
 */

import { cborResponse } from "../cbor-api/cbor-response.js";
import { problemResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors } from "../cbor-api/problem-details.js";
import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import { resolveGenesisAuth } from "../payments/genesis-auth.js";
import { buildGenesisRegistrationResponse } from "../payments/genesis-registration-response.js";
import {
  logIdWireToUuid,
  registrationRecordFromChainBinding,
  writeRegistration,
} from "../payments/registration-store.js";
import { getForestGenesis } from "./get-forest-genesis.js";
import { postForestGenesis, type PostGenesisEnv } from "./post-genesis.js";

export interface ForestHandlerEnv extends PostGenesisEnv {
  NODE_ENV: string;
  resolveReceiptAuthority?: ReceiptAuthorityResolver;
}

function attachCors(
  res: Response,
  corsHeaders: Record<string, string>,
): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    headers.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * @returns a `Response` for any `/api/forest` or `/api/forest/**` path, else `null`.
 */
export async function handleForestRequest(
  request: Request,
  pathname: string,
  env: ForestHandlerEnv,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (pathname !== "/api/forest" && !pathname.startsWith("/api/forest/")) {
    return null;
  }

  if (pathname === "/api/forest") {
    return attachCors(
      ClientErrors.notFound(
        "Not Found",
        "No resource at /api/forest (use /api/forest/{log-id}/genesis)",
      ),
      corsHeaders,
    );
  }

  const rest = pathname.slice("/api/forest/".length);
  const parts = rest.split("/").filter(Boolean);

  if (parts.length === 2 && parts[1] === "genesis") {
    const logIdSeg = parts[0]!;
    if (request.method === "GET") {
      const res = await getForestGenesis(logIdSeg, env);
      return attachCors(res, corsHeaders);
    }
    if (request.method === "POST") {
      const auth = await resolveGenesisAuth(request, logIdSeg, env);
      if (auth instanceof Response) return attachCors(auth, corsHeaders);

      const genesisResult = await postForestGenesis(request, logIdSeg, env);
      if (genesisResult instanceof Response) {
        return attachCors(genesisResult, corsHeaders);
      }

      const rUuid = logIdWireToUuid(genesisResult.logIdWire);
      if (auth.mode === "onboard") {
        await writeRegistration(
          env,
          genesisResult.logIdWire,
          registrationRecordFromChainBinding({
            class: "payment-authoritative",
            onboardTokenRef: auth.tokenHash,
            chainBinding: genesisResult.chainBinding,
          }),
        );
        return attachCors(
          cborResponse(
            buildGenesisRegistrationResponse(
              rUuid,
              "payment-authoritative",
              genesisResult.chainBinding,
            ),
            201,
          ),
          corsHeaders,
        );
      }

      await writeRegistration(
        env,
        genesisResult.logIdWire,
        registrationRecordFromChainBinding({
          class: "regular",
          endorsedBy: auth.endorserUuid,
          chainBinding: genesisResult.chainBinding,
        }),
      );
      return attachCors(
        cborResponse(
          buildGenesisRegistrationResponse(
            rUuid,
            "regular",
            genesisResult.chainBinding,
            auth.endorserUuid,
          ),
          201,
        ),
        corsHeaders,
      );
    }
    return attachCors(
      problemResponse(405, "Method Not Allowed", "about:blank", {
        detail: `Method ${request.method} not allowed for ${pathname}`,
      }),
      corsHeaders,
    );
  }

  return attachCors(
    problemResponse(404, "Not Found", "about:blank", {
      detail: `Unknown forest route ${pathname}`,
    }),
    corsHeaders,
  );
}
