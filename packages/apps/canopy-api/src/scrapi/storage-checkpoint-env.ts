/** Log ID as UUID string (ownerLogId from grant). */
export type LogIdUuid = string;

/** Storage config: R2 bucket (Workers binding) for massifs/checkpoints. */
export interface StorageCheckpointEnvR2 {
  r2Mmrs: R2Bucket;
  massifHeight: number;
}

/** Storage config: base URL to fetch checkpoint objects by path (e.g. public R2 or CDN). */
export interface StorageCheckpointEnvUrl {
  objectStorageRootUrl: string;
  massifHeight: number;
}

export type StorageCheckpointEnv =
  | StorageCheckpointEnvR2
  | StorageCheckpointEnvUrl;
