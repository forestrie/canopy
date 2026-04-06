/**
 * Custodian ops routes at the **ingress origin** (no `/v1` prefix):
 * `/healthz`, `/readyz`, `/version`, `/metrics`.
 */

import { custodianApiOpsBaseUrl } from "./custodian-api-env.js";

export async function getCustodianHealthz(baseUrl: string): Promise<{
  status: number;
  text: string;
}> {
  const base = custodianApiOpsBaseUrl(baseUrl);
  const res = await fetch(`${base}/healthz`);
  return { status: res.status, text: await res.text() };
}

export async function getCustodianReadyz(baseUrl: string): Promise<{
  status: number;
  text: string;
}> {
  const base = custodianApiOpsBaseUrl(baseUrl);
  const res = await fetch(`${base}/readyz`);
  return { status: res.status, text: await res.text() };
}

export interface CustodianVersionJson {
  version?: string;
  commit?: string;
  buildDate?: string;
}

export async function getCustodianVersionJson(
  baseUrl: string,
): Promise<{ status: number; json: CustodianVersionJson | null }> {
  const base = custodianApiOpsBaseUrl(baseUrl);
  const res = await fetch(`${base}/version`);
  if (!res.ok) {
    return { status: res.status, json: null };
  }
  try {
    const json = (await res.json()) as CustodianVersionJson;
    return { status: res.status, json };
  } catch {
    return { status: res.status, json: null };
  }
}

export async function getCustodianMetricsText(baseUrl: string): Promise<{
  status: number;
  text: string;
}> {
  const base = custodianApiOpsBaseUrl(baseUrl);
  const res = await fetch(`${base}/metrics`);
  return { status: res.status, text: await res.text() };
}
