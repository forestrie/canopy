/** Subset of Env needed to validate Custodian URL for grant paths (receipt path uses APP_TOKEN separately). */
export interface CanopyBootstrapTrioEnv {
  NODE_ENV: string;
  CUSTODIAN_URL?: string;
}
