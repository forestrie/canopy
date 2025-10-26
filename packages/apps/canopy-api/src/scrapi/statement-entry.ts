export interface StatementEntry {
  entryId: string;
  logId: string;
  statementId: string;
  fenceIndex: number;
  timestamp: number;
  contentHash: string;
  size: number;
  sequenced: boolean;
  mmrIndex?: number;
}
