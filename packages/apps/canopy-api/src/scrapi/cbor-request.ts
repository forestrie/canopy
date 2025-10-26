
import { decode as decodeCbor } from 'cbor-x';
import { CBOR_MIME } from './cbor-const';

/**
 * Parse CBOR request body
 */
export async function parseCborBody<T = unknown>(request: Request): Promise<T> {
  const arrayBuffer = await request.arrayBuffer();
  return decodeCbor(new Uint8Array(arrayBuffer)) as T;
}

/**
 * Validate content size
 */
export function validateContentSize(
  request: Request,
  maxSize: number
): { valid: boolean; size?: number; error?: string } {
  const contentLength = request.headers.get('content-length');
  if (!contentLength) {
    return { valid: true }; // Accept without header - will be checked when reading body
  }
  const size = parseInt(contentLength, 10);
  if (size > maxSize) {
    return {
      valid: false,
      size,
      error: `Content size ${size} exceeds maximum ${maxSize} bytes`
    };
  }
  return { valid: true, size };
}

export function getContentSize(request: Request): number | undefined {
  const contentLength = request.headers.get('content-length');
  if (!contentLength) {
    return undefined;
  }
  return parseInt(contentLength, 10);
}

export function convertHeaders(init: HeadersInit): Record<string, string> {
  if (init instanceof Headers) {
    const result: Record<string, string> = {};
    init.forEach((value, key) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  } else if (Array.isArray(init)) {
    const result: Record<string, string> = {};
    init.forEach(([key, value]) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  } else {
    const result: Record<string, string> = {};
    Object.entries(init).forEach(([key, value]) => {
      result[key.toLowerCase()] = value;
    });
    return result;
  }
}

/**
 * Check ETag header for conditional requests
 */
export function checkETag(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get('if-none-match');
  if (!ifNoneMatch) return false;
  // Support wildcard, quoted and unquoted ETags
  return ifNoneMatch === '*' || ifNoneMatch === etag || ifNoneMatch === `"${etag}"`;
}

/**
 * Check if request accepts CBOR
 */
export function acceptsCbor(request: Request): boolean {
  const accept = request.headers.get('accept');
  if (!accept) return true; // No accept header means accept all
  return accept.split(',').some((v) => {
    const trimmed = v.trim().toLowerCase();
    return trimmed.startsWith(CBOR_MIME) || trimmed.includes('*/*') || trimmed === '*';
  });
}
