/**
 * Seal hints on certificate acceptance — the late-delegation wake path
 * (ADR-0007 seal-hint shape, FOR-380; applied here to certificates).
 *
 * When a sealer's delegation request finds no certificate, the coordinator
 * parks a pending row and the sealer defers the checkpoint
 * (`ErrDelegationPending`) — its retry then rides queue redelivery or the
 * resync sweep, minutes away. A certificate submitted in that window (the
 * BYOK / wallet-signed flow is exactly this: the key owner signs AFTER the
 * sealer first asked) therefore sits idle until the sealer happens to come
 * back, even though the coordinator knows the demand is now satisfiable.
 *
 * This module closes that gap from the coordinator side: when an accepted
 * certificate covers parked pending rows, publish a seal hint for the log to
 * the sealer's queue. The hint reproduces the R2 PutObject notification
 * shape the sealer's consumer already parses (`v2/merklelog/massifs/
 * {height}/{logId}/{index}.log` — only the height and log id segments are
 * read); the sealer re-derives all real work from R2 state, so duplicate or
 * spurious hints are harmless (at-least-once, no authority). Publishing is
 * fire-and-forget with a bounded retry, mirroring the ranger's publisher —
 * a failure only means the pre-existing slow path applies.
 *
 * Feature-off by default: no-op unless SEAL_HINT_QUEUE_URL is configured.
 */

/** Env slice for seal-hint publication (all optional — absent = disabled). */
export interface SealHintEnv {
  /**
   * Cloudflare Queues API base for the sealer's trigger queue — the same
   * shape as the sealer's QUEUE_URL / the ranger's SEAL_HINT_QUEUE_URL:
   * `https://api.cloudflare.com/client/v4/accounts/{id}/queues/{queueId}`.
   */
  SEAL_HINT_QUEUE_URL?: string;
  /** Bearer for the queue push API. Set via `wrangler secret put`. */
  SEAL_HINT_QUEUE_TOKEN?: string;
  /**
   * Massif heights to hint, comma-separated (default "14"). One hint per
   * height; the sealer ignores hints for heights a log doesn't use.
   */
  SEAL_HINT_MASSIF_HEIGHTS?: string;
}

/** Marks coordinator-originated hints in sealer_seal_trigger_total{source}. */
export const COORDINATOR_HINT_SOURCE = "coordinator_certificate";

const DEFAULT_MASSIF_HEIGHTS = [14];
const PUBLISH_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 2_000;
const RETRY_DELAY_MS = 200;

/** hex32 → canonical uuid string (the log id segment of a massif key). */
export function hex32ToUuid(hex32: string): string {
  return (
    `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-${hex32.slice(12, 16)}-` +
    `${hex32.slice(16, 20)}-${hex32.slice(20, 32)}`
  );
}

export function parseMassifHeights(csv: string | undefined): number[] {
  if (!csv) return DEFAULT_MASSIF_HEIGHTS;
  const heights = csv
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((h) => Number.isInteger(h) && h > 0 && h <= 255);
  return heights.length > 0 ? heights : DEFAULT_MASSIF_HEIGHTS;
}

/**
 * The R2 PutObject-shaped hint body. The index segment is required by the
 * consumer's path validator but never read — CheckpointLog re-derives the
 * head massif from R2.
 */
export function buildSealHint(
  logIdHex32: string,
  massifHeight: number,
  eventTime: string,
): {
  action: string;
  object: { key: string };
  eventTime: string;
  hintSource: string;
} {
  return {
    action: "PutObject",
    object: {
      key: `v2/merklelog/massifs/${massifHeight}/${hex32ToUuid(logIdHex32)}/0000000000000000.log`,
    },
    eventTime,
    hintSource: COORDINATOR_HINT_SOURCE,
  };
}

/**
 * Publish one hint per configured massif height. Never throws — failures are
 * logged and the pre-hint slow path (queue redelivery / resync) still applies.
 */
export async function publishCertificateSealHints(
  env: SealHintEnv,
  logIdHex32: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const base = env.SEAL_HINT_QUEUE_URL?.trim();
  if (!base) return;
  const pushUrl = `${base.replace(/\/+$/, "").replace(/\/messages$/, "")}/messages`;
  const eventTime = new Date().toISOString();

  for (const height of parseMassifHeights(env.SEAL_HINT_MASSIF_HEIGHTS)) {
    const hint = buildSealHint(logIdHex32, height, eventTime);
    // content_type "text" delivers the body as a JSON string token — the
    // encoding the sealer's consumer double-decodes for R2 notifications.
    const body = JSON.stringify({
      body: JSON.stringify(hint),
      content_type: "text",
    });
    for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (env.SEAL_HINT_QUEUE_TOKEN)
          headers.Authorization = `Bearer ${env.SEAL_HINT_QUEUE_TOKEN}`;
        const res = await fetchImpl(pushUrl, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        if (res.ok) break;
        console.warn(
          `seal hint publish HTTP ${res.status} (attempt ${attempt}/${PUBLISH_ATTEMPTS}) log=${logIdHex32} height=${height}`,
        );
      } catch (err) {
        console.warn(
          `seal hint publish failed (attempt ${attempt}/${PUBLISH_ATTEMPTS}) log=${logIdHex32} height=${height}: ${err}`,
        );
      }
      if (attempt < PUBLISH_ATTEMPTS)
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}
