export type SCRAPIOperationStatus = "running" | "succeeded" | "failed";

export interface SCRAPIOperationError {
  code?: string;
  message: string;
}

export interface SCRAPIOperation {
  operationId: string;
  status: SCRAPIOperationStatus;
  type: "register-signed-statement" | string;
  created: number;
  completed?: number;
  error?: SCRAPIOperationError;
}

/**
 * Returns the index and etag from the path if they are present.
 *
 * If neither are present an error is thrown.
 *
 * In a regular complete case, the path will have the form:
 *
 *  entries/00000000
 *
 * And the pending path will be
 *
 *  entries/00000000/{ETAG}
 *
 * An etag is only available in paths for incomplete entries
 *
 * @param entryPath ()
 * @returns
 */
export function parseEntry(entryPath: string): {
  index?: string;
  etag?: string;
} {
  const segments = entryPath.split("/");
  return parseEntrySegments(segments);
}

// see parseEntry
export function parseEntrySegments(segments: string[]): {
  index?: string;
  etag?: string;
} {
  if (segments.length < 2) {
    if (/^[0-9a-fA-F]{32}$/.test(segments[0])) return { etag: segments[0] };
    if (/^d{8}$/.test(segments[0])) return { index: segments[0] };
  }
  const end = segments.length - 1;
  if (/^[0-9a-fA-F]{32}$/.test(segments[end])) {
    if (/^d{8}$/.test(segments[end - 1]))
      return { index: segments[end - 1], etag: segments[end] };
    throw new Error(
      `invalid path. fence index segment invalid: ${segments[end - 1]}`,
    );
  }
  if (!/^d{8}$/.test(segments[end]))
    throw new Error(
      `invalid path. index segment for completed entry invalid: ${segments[end]}`,
    );
  return { index: segments[end] };
}

/**
 * Check if an entry path represents a completed registration
 * @param entryPath - The entry ID or full path
 * @returns True if entry is completed (no MD5 suffix)
 */
export function isCompletedEntry(entryPath: string): boolean {
  const segments = entryPath.split("/");

  // If there is only a single segment, return true if its an 8 char number
  if (segments.length < 2) return /^d{8}$/.test(entryPath);

  // There are segments, so only consider the last. Any sub path means it is
  // not a reference to a completed entry

  return /^d{8}$/.test(segments[segments.length - 1]);
}
