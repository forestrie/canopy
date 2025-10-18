/**
 * Unit tests for register-signed-statement
 */
// import {
//   env
// } from "cloudflare:test";
import { beforeEach, describe, it } from 'vitest';
//import { createMockR2Bucket } from '../src/lib/test-helpers/r2-mock';

// import { POST as POSTentries } from '../../routes/entries/+server';

describe('registerSignedStatement', () => {

	const apiKey = 'test-api-key';
  const testLogId = 'test-log-123';

  // let mockBucket: R2Bucket;
  beforeEach(() => {
    // mockBucket = createMockR2Bucket();
    // vi.clearAllMocks();
  });

  it('should work', async () => {

    console.log('R2 in env:');

    /*
    // Mock COSE Sign1 structure (CBOR array with 4 elements)
		const mockCoseSign1 = Buffer.from([
			0x84, // CBOR array of 4 elements
			0x40, // protected headers (empty bstr)
			0xa0, // unprotected headers (empty map)
			0x45, 0x48, 0x65, 0x6c, 0x6c, 0x6f, // payload "Hello"
			0x40  // signature (empty bstr)
		]);
    const request = new Request('http://localhost/entries', {
      method: 'POST',
      headers: {
      'Content-Type': 'application/cose; cose-type="cose-sign1"',
      'Authorization': `Bearer ${apiKey}`
      },
      body: mockCoseSign1
    });

    // const response = POSTentries(request, { env });
    const ctx = createExecutionContext();
    const response = await registerSignedStatement(request, testLogId, env.R2 as R2Bucket);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(400);
    */
  });

  /*
  it('should register a valid COSE Sign1 statement', async () => {
    // The signed message from the user
    // This is a minimal COSE Sign1 structure: array of 4 elements with "Hello" payload
    const signedMessage = new Uint8Array([
      0x84, // CBOR array with 4 elements
      0x40, // First element: empty protected headers (bstr of length 0)
      0xa0, // Second element: empty unprotected headers (map)
      0x45, // Third element: payload (bstr of length 5)
      0x48, 0x65, 0x6c, 0x6c, 0x6f, // "Hello" in ASCII
      0x40  // Fourth element: empty signature (bstr of length 0)
    ]);

    const ctx = createExecutionContext();

    // Create a mock request with the signed message
    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/cose',
        'Content-Length': signedMessage.length.toString()
      },
      body: signedMessage
    });

    // Call the function
    const response = await registerSignedStatement(request, testLogId, mockBucket);

    // Verify response status
    expect(response.status).toBe(202); // Accepted

    // Verify response headers
    expect(response.headers.get('content-type')).toContain('application/cbor');

    // Verify R2 storage was called
    expect(mockBucket.put).toHaveBeenCalledTimes(1);

    // Verify the call to R2 put
    const putCall = (mockBucket.put as any).mock.calls[0];
    expect(putCall[0]).toMatch(/^logs\/test-log-123\/leaves\/0\//); // Path
    expect(putCall[1]).toBeInstanceOf(Uint8Array); // Content as Uint8Array

    // Verify the stored data matches what we sent
    const storedData = putCall[1] as Uint8Array;
    expect(storedData).toEqual(signedMessage);

    // Verify the metadata
    const metadata = putCall[2];
    expect(metadata.customMetadata.logId).toBe(testLogId);
    expect(metadata.customMetadata.fenceIndex).toBe('0');
    expect(metadata.customMetadata.contentType).toContain('application/cose');
    expect(metadata.customMetadata.sequenced).toBe('false');
  });

  it('should handle direct COSE with application/cose content-type', async () => {
    // Same signed message but sent directly as application/cose
    const signedMessage = new Uint8Array([
      0x84, 0x40, 0xa0, 0x45, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x40
    ]);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/cose; cose-type="cose-sign1"',
        'Content-Length': signedMessage.length.toString()
      },
      body: signedMessage
    });

    const response = await registerSignedStatement(request, testLogId, mockBucket);

    expect(response.status).toBe(202);
    expect(mockBucket.put).toHaveBeenCalledTimes(1);

    // Verify the stored data matches exactly
    const putCall = (mockBucket.put as any).mock.calls[0];
    const storedData = putCall[1] as Uint8Array;
    expect(storedData).toEqual(signedMessage);
  });

  it('should reject statement with invalid COSE structure', async () => {
    // Invalid: not starting with 0x84 (CBOR array marker)
    const invalidMessage = new Uint8Array([
      0x83, // Wrong: array of 3 elements instead of 4
      0x40, 0xa0, 0x45, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x40
    ]);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/cose',
        'Content-Length': invalidMessage.length.toString()
      },
      body: invalidMessage
    });

    const response = await registerSignedStatement(request, testLogId, mockBucket);

    expect(response.status).toBe(400); // Bad Request
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it('should reject statement that is too small', async () => {
    // Too small to be valid COSE Sign1
    const tooSmall = new Uint8Array([0x84, 0x40]);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/cose',
        'Content-Length': tooSmall.length.toString()
      },
      body: tooSmall
    });

    const response = await registerSignedStatement(request, testLogId, mockBucket);

    expect(response.status).toBe(400);
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it('should reject unsupported media type', async () => {
    const signedMessage = new Uint8Array([
      0x84, 0x40, 0xa0, 0x45, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x40
    ]);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', // Unsupported
        'Content-Length': signedMessage.length.toString()
      },
      body: signedMessage
    });

    const response = await registerSignedStatement(request, testLogId, mockBucket);

    expect(response.status).toBe(415); // Unsupported Media Type
    expect(mockBucket.put).not.toHaveBeenCalled();
  });

  it('should return operation ID in response', async () => {
    const signedMessage = new Uint8Array([
      0x84, 0x40, 0xa0, 0x45, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x40
    ]);

    const request = new Request('http://localhost/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/cose',
        'Content-Length': signedMessage.length.toString()
      },
      body: signedMessage
    });

    const response = await registerSignedStatement(request, testLogId, mockBucket);

    expect(response.status).toBe(202);

    // Check Location header
    const location = response.headers.get('location');
    expect(location).toMatch(/^\/api\/v1\/logs\/test-log-123\/operations\/\d{8}-.+$/);

    // Parse response body to check operation ID
    const responseBody = await response.arrayBuffer();
    expect(responseBody.byteLength).toBeGreaterThan(0);
  });
  */
});