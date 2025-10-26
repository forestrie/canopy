import { encode as encodeCbor } from 'cbor-x';

import { CBOR_MIME } from './cbor-const';
import { convertHeaders } from './cbor-request'


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

export function problemResponse(
  status: number,
  title: string,
  type = 'about:blank',
  opts: any = {}
): Response {
  const body: Record<string, unknown> = { type, title, status };

  const { instance, headers, detail } = opts;

  if (detail) body.detail = detail;
  if (instance) body.instance = instance;
  return cborResponse(body, status, headers);
}

export function requireAcceptCbor(request: Request): Response | null {
  const accept = request.headers.get('accept');
  if (!accept) return null;
  const acceptable = accept
    .split(',')
    .some((v) => v.trim().toLowerCase().startsWith(CBOR_MIME) || v.includes('*/*'));
  return acceptable ? null : problemResponse(406, 'Not Acceptable', 'Only application/cbor is supported');
}

export function requireContentTypeCbor(request: Request): Response | null {
  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith(CBOR_MIME)) {
    return problemResponse(415, 'Unsupported Media Type', 'Use application/cbor');
  }
  return null;
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
 * Return 303 See Other response for async operations
 * Per SCRAPI spec 2.1.3.2, registration is running and client should poll Location
 */
export function seeOtherResponse(
  location: string,
  retryAfter?: number
): Response {
  const headers: Record<string, string> = {
    Location: location,
    'Content-Length': '0'
  };

  if (retryAfter) {
    headers['Retry-After'] = String(retryAfter);
  }

  return new Response(null, {
    status: 303,
    headers
  });
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
 * Generate ETag from content
 */
export async function generateETag(content: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('MD5', content.buffer as ArrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
