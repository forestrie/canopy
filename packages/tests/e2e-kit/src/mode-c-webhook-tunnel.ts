/**
 * Ephemeral cloudflared quick tunnel for Mode C webhook push e2e (FOR-127).
 *
 * Dev/CI only — exposes localhost webhook receiver to deployed coordinator.
 */

import { spawn, type ChildProcess } from "node:child_process";

const TRY_CLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\/?/i;

export interface ModeCWebhookTunnel {
  /** HTTPS origin without trailing slash. */
  publicBaseUrl: string;
  close(): Promise<void>;
}

/** Parse cloudflared stdout/stderr for a published quick-tunnel URL. */
export function parseCloudflaredPublicUrl(line: string): string | null {
  const match = line.match(TRY_CLOUDFLARE_URL_RE);
  if (!match) return null;
  return match[0].replace(/\/$/, "");
}

async function killCloudflared(proc: ChildProcess | undefined): Promise<void> {
  if (!proc?.pid) return;
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 3_000);
    proc.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
  });
}

/**
 * Start `cloudflared tunnel --url http://127.0.0.1:{localPort}` and wait for a
 * public HTTPS origin suitable for coordinator webhook registration.
 */
export async function startModeCWebhookTunnel(opts: {
  localPort: number;
  timeoutMs?: number;
  cloudflaredPath?: string;
}): Promise<ModeCWebhookTunnel> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const bin = opts.cloudflaredPath ?? "cloudflared";
  const localUrl = `http://127.0.0.1:${opts.localPort}`;

  return new Promise((resolve, reject) => {
    let proc: ChildProcess | undefined;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killCloudflared(proc).finally(() => reject(error));
    };

    const timer = setTimeout(() => {
      fail(
        new Error(
          `cloudflared tunnel did not publish a URL within ${timeoutMs}ms ` +
            `(local ${localUrl})`,
        ),
      );
    }, timeoutMs);

    proc = spawn(bin, ["tunnel", "--url", localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onLine = (line: string) => {
      const url = parseCloudflaredPublicUrl(line);
      if (!url || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        publicBaseUrl: url,
        close: () => killCloudflared(proc),
      });
    };

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) onLine(line);
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    proc.on("error", (err) => {
      fail(
        new Error(
          `failed to spawn ${bin}: ${err.message}. Install cloudflared for ` +
            "webhook push e2e (see tests/system/docs/byok-mode-c-webhook-seal.md).",
        ),
      );
    });

    proc.on("exit", (code) => {
      if (!settled) {
        fail(
          new Error(
            `cloudflared exited before publishing URL (code ${code ?? "?"})`,
          ),
        );
      }
    });
  });
}

/**
 * Poll the public tunnel origin until traffic reaches the local receiver (GET / → 404).
 */
export async function waitForModeCWebhookTunnelReachable(
  publicBaseUrl: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const probeUrl = `${publicBaseUrl.replace(/\/$/, "")}/`;
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(probeUrl, { method: "GET", redirect: "follow" });
      if (res.status === 404) return;
      lastError = `unexpected status ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `cloudflared origin ${publicBaseUrl} not reachable within ${timeoutMs}ms (${lastError})`,
  );
}
