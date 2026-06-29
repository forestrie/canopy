/**
 * Start in-repo Mode C webhook receiver with public ingress for coordinator push.
 */

import type { ModeCWebhookReceiverConfig } from "./mode-c-webhook-receiver.js";
import { startModeCWebhookReceiver } from "./mode-c-webhook-receiver.js";
import { modeCWebhookPublicBaseFromEnv } from "./mode-c-e2e-env.js";
import {
  startModeCWebhookTunnel,
  waitForModeCWebhookTunnelReachable,
  type ModeCWebhookTunnel,
} from "./mode-c-webhook-tunnel.js";

export interface ModeCWebhookIngress {
  webhookUrl: string;
  receiver: Awaited<ReturnType<typeof startModeCWebhookReceiver>>;
  tunnel: ModeCWebhookTunnel | null;
  close(): Promise<void>;
}

/**
 * Bind localhost receiver, then expose via explicit env base or cloudflared tunnel.
 */
export async function startModeCWebhookIngress(
  config: Omit<ModeCWebhookReceiverConfig, "publicWebhookBaseUrl">,
): Promise<ModeCWebhookIngress> {
  const receiver = await startModeCWebhookReceiver({
    ...config,
    publicWebhookBaseUrl: undefined,
  });

  const explicitBase = modeCWebhookPublicBaseFromEnv();
  let tunnel: ModeCWebhookTunnel | null = null;
  let publicBase = explicitBase;

  if (!publicBase) {
    tunnel = await startModeCWebhookTunnel({ localPort: receiver.localPort });
    publicBase = tunnel.publicBaseUrl;
  }

  await waitForModeCWebhookTunnelReachable(publicBase);

  const webhookUrl = `${publicBase.replace(/\/$/, "")}/webhook`;

  return {
    webhookUrl,
    receiver,
    tunnel,
    close: async () => {
      await receiver.close();
      if (tunnel) await tunnel.close();
    },
  };
}
