import { decode as decodeCbor, encode as encodeCbor } from 'cbor-x';

export const CBOR_MIME = 'application/cbor';

// Re-export encode/decode for convenience
// export const encode = encodeCbor;
// export const decode = decodeCbor;

export function cborResponse(data: unknown, status = 200, contentTypeOrHeaders?: string | HeadersInit): Response {
  const encoded = encodeCbor(data) as Uint8Array;

  // Determine headers
  let headers: Record<string, string>;
  if (typeof contentTypeOrHeaders === 'string') {
    // contentTypeOrHeaders is a content-type string
    headers = { 'content-type': contentTypeOrHeaders };
  } else if (contentTypeOrHeaders) {
    // contentTypeOrHeaders is a HeadersInit object
    headers = { 'content-type': CBOR_MIME, ...convertHeaders(contentTypeOrHeaders) };
  } else {
    headers = { 'content-type': CBOR_MIME };
  }

  // Add Content-Length
  headers['content-length'] = String(encoded.byteLength);

  // Add Cache-Control based on status
  if (!headers['cache-control']) {
    if (status >= 400) {
      headers['cache-control'] = 'no-cache';
    } else {
      headers['cache-control'] = 'public, max-age=31536000, immutable';
    }
  }

  return new Response(encoded as unknown as BodyInit, {
    status,
    headers
  });
}

function convertHeaders(init: HeadersInit): Record<string, string> {
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

export function problem(
  status: number,
  title: string,
  detail?: string,
  type = 'about:blank',
  instance?: string
): Response {
  const body: Record<string, unknown> = { type, title, status };
  if (detail) body.detail = detail;
  if (instance) body.instance = instance;
  return cborResponse(body, status);
}

export function requireAcceptCbor(request: Request): Response | null {
  const accept = request.headers.get('accept');
  if (!accept) return null;
  const acceptable = accept
    .split(',')
    .some((v) => v.trim().toLowerCase().startsWith(CBOR_MIME) || v.includes('*/*'));
  return acceptable ? null : problem(406, 'Not Acceptable', 'Only application/cbor is supported');
}

export function requireContentTypeCbor(request: Request): Response | null {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith(CBOR_MIME)) {
    return problem(415, 'Unsupported Media Type', 'Use application/cbor');
  }
  return null;
}

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

/**
 * Return 202 Accepted response with operation location
 */
export function acceptedResponse(
  operationId: string,
  location: string,
  data?: Record<string, unknown>
): Response {
  return cborResponse(data || { operationId }, 202, {
    Location: location
  });
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
 * Return 304 Not Modified response
 */
export function notModifiedResponse(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: etag
    }
  });
}

/**
 * Create a problem details response (alias for problem function)
 */
export function problemResponse(
  status: number,
  title: string,
  detail?: string,
  type?: string,
  instance?: string,
  additional?: Record<string, unknown>
): Response {
  const body: Record<string, unknown> = {
    type: type || 'about:blank',
    title,
    status,
    ...(additional || {})
  };
  if (detail) body.detail = detail;
  if (instance) body.instance = instance;
  return cborResponse(body, status);
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

/**
 * Generate ETag from content
 */
export async function generateETag(content: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('MD5', content.buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
