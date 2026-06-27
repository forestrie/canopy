export interface CoordinatorEnabledResponse {
  enabled: boolean;
}

export interface CoordinatorEnabledClientEnv {
  DELEGATION_COORDINATOR_URL?: string;
  COORDINATOR_APP_TOKEN?: string;
}

export type CoordinatorEnabledResult =
  | { ok: true; enabled: boolean }
  | { ok: false; status: number; detail: string };
