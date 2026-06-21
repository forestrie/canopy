/** Protected + payload bytes and Sig_structure for external signing. */
export interface DelegationToBeSigned {
  protectedBytes: Uint8Array;
  payloadBytes: Uint8Array;
  sigStructureBytes: Uint8Array;
}
