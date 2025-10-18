import { validateUUID } from "./validation";

export type SCRAPIOperationStatus = 'running' | 'succeeded' | 'failed';

export interface SCRAPIOperationError {
  code?: string;
  message: string;
}

export interface SCRAPIOperation {
  operationId: string;
  status: SCRAPIOperationStatus;
  type: 'register-signed-statement' | string;
  created: number;
  completed?: number;
  error?: SCRAPIOperationError;
}
