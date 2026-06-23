/**
 * `/api/forest/**` dispatcher. POST genesis: onboard token or endorsement grant.
 */

import { cborResponse } from "../cbor-api/cbor-response.js";
import { problemResponse } from "../cbor-api/cbor-response.js";
import { ClientErrors, ServerErrors } from "../cbor-api/problem-details.js";
import type { ReceiptAuthorityResolver } from "../env/receipt-authority-resolver.js";
import { resolveGenesisAuth } from "../payments/genesis-auth.js";
import { buildGenesisRegistrationResponse } from "../payments/genesis-registration-response.js";
import {
  logIdWireToUuid,
  registrationRecordFromChainBinding,
  writeRegistration,
} from "../payments/registration-store.js";
import type { CoordinatorRegistrationStatus } from "./coordinator-registration-status.js";
import {
  forwardCoordinatorRegistration,
  isCoordinatorForwardConfigured,
  type CoordinatorForwardEnv,
} from "./forward-coordinator-registration.js";
import { getForestGenesis } from "./get-forest-genesis.js";
import {
  postForestGenesis,
  type PostGenesisEnv,
  type PostGenesisSuccess,
} from "./post-genesis.js";
import {
  GenesisWebhookUrlValidationError,
  validateGenesisWebhookUrl,
} from "./validate-genesis-webhook-url.js";
import type { RegistrationClass } from "../payments/registration-class.js";

export interface ForestHandlerEnv
  extends PostGenesisEnv,
    CoordinatorForwardEnv {
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

function parseGenesisWebhookUrlParam(
  request: Request,
  env: ForestHandlerEnv,
): { webhookUrl?: string } | Response {
  const raw = new URL(request.url).searchParams.get("webhookUrl");
  if (raw === null || raw.trim() === "") {
    return {};
  }
  try {
    return {
      webhookUrl: validateGenesisWebhookUrl(raw, {
        allowInsecureLocal: env.NODE_ENV === "dev",
      }),
    };
  } catch (error) {
    const detail =
      error instanceof GenesisWebhookUrlValidationError
        ? error.message
        : "Invalid webhookUrl";
    return ClientErrors.badRequest(detail);
  }
}

async function coordinatorStatusForGenesis(
  env: ForestHandlerEnv,
  genesisResult: PostGenesisSuccess,
  webhookUrl: string,
): Promise<CoordinatorRegistrationStatus> {
  return forwardCoordinatorRegistration({
    coordinatorBaseUrl: env.DELEGATION_COORDINATOR_URL!.trim(),
    coordinatorAppToken: env.COORDINATOR_APP_TOKEN!.trim(),
    logIdWire: genesisResult.logIdWire,
    genesisAlg: genesisResult.genesisAlg,
    bootstrapKey: genesisResult.bootstrapKey,
    webhookUrl,
  });
}

async function finishGenesisPost(
  env: ForestHandlerEnv,
  genesisResult: PostGenesisSuccess,
  registrationClass: RegistrationClass,
  record: Parameters<typeof writeRegistration>[2],
  endorsedBy: string | undefined,
  webhookUrl: string | undefined,
): Promise<Response> {
  await writeRegistration(env, genesisResult.logIdWire, record);

  let coordinator: CoordinatorRegistrationStatus | undefined;
  if (webhookUrl) {
    coordinator = await coordinatorStatusForGenesis(
      env,
      genesisResult,
      webhookUrl,
    );
    if (coordinator.publicRoot !== "ok" || coordinator.webhook !== "ok") {
      const detail =
        coordinator.detail ??
        `coordinator registration incomplete (publicRoot=${coordinator.publicRoot}, webhook=${coordinator.webhook})`;
      return ServerErrors.serviceUnavailable(detail);
    }
  }

  const rUuid = logIdWireToUuid(genesisResult.logIdWire);
  return cborResponse(
    buildGenesisRegistrationResponse(
      rUuid,
      registrationClass,
      genesisResult.chainBinding,
      endorsedBy,
      coordinator,
    ),
    201,
  );
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

      const webhookParsed = parseGenesisWebhookUrlParam(request, env);
      if (webhookParsed instanceof Response) {
        return attachCors(webhookParsed, corsHeaders);
      }
      if (webhookParsed.webhookUrl && !isCoordinatorForwardConfigured(env)) {
        return attachCors(
          ServerErrors.serviceUnavailable(
            "webhookUrl requires delegation coordinator configuration (DELEGATION_COORDINATOR_URL and COORDINATOR_APP_TOKEN)",
          ),
          corsHeaders,
        );
      }

      const genesisResult = await postForestGenesis(request, logIdSeg, env);
      if (genesisResult instanceof Response) {
        return attachCors(genesisResult, corsHeaders);
      }

      if (auth.mode === "onboard") {
        return attachCors(
          await finishGenesisPost(
            env,
            genesisResult,
            "payment-authoritative",
            registrationRecordFromChainBinding({
              class: "payment-authoritative",
              onboardTokenRef: auth.tokenHash,
              chainBinding: genesisResult.chainBinding,
            }),
            undefined,
            webhookParsed.webhookUrl,
          ),
          corsHeaders,
        );
      }

      return attachCors(
        await finishGenesisPost(
          env,
          genesisResult,
          "regular",
          registrationRecordFromChainBinding({
            class: "regular",
            endorsedBy: auth.endorserUuid,
            chainBinding: genesisResult.chainBinding,
          }),
          auth.endorserUuid,
          webhookParsed.webhookUrl,
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
