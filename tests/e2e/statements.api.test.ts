import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import { encode as encodeCBOR, decode as decodeCBOR } from 'cbor-x';

test.describe('Statements API (CBOR)', () => {
  const logId = uuidv4();
  const apiKey = 'test-api-key';

  test('POST /api/v1/logs/[logId]/statements accepts CBOR content (CBOR response)', async ({ request }) => {
    const statement = { type: 'test-statement', data: 'test-data', timestamp: Date.now() };
    const cborContent = encodeCBOR(statement);

    const response = await request.post(`/api/v1/logs/${logId}/statements`, {
      data: cborContent,
      headers: {
        'Content-Type': 'application/cbor',
        'Accept': 'application/cbor',
        'Authorization': `Bearer ${apiKey}`
      }
    });

    expect(response.status()).toBe(202);
    expect(response.headers()['content-type']).toContain('application/cbor');
    const buf = await response.body();
    const result = decodeCBOR(Buffer.from(buf));
    expect(result.status).toBe('accepted');
    expect(result.logId).toBe(logId);
    expect(result.statementId).toBeTruthy();
    expect(result.fenceIndex).toBe(0);
  });

  test('POST rejects non-CBOR with 415 problem details', async ({ request }) => {
    const response = await request.post(`/api/v1/logs/${logId}/statements`, {
      data: { foo: 'bar' },
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/cbor',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    expect(response.status()).toBe(415);
    const err = decodeCBOR(Buffer.from(await response.body()));
    expect(err.title).toBe('Unsupported Media Type');
  });

  test('POST validates log ID format (400)', async ({ request }) => {
    const invalidLogId = 'not-a-uuid';
    const cborContent = encodeCBOR({ any: 'data' });
    const response = await request.post(`/api/v1/logs/${invalidLogId}/statements`, {
      data: cborContent,
      headers: {
        'Content-Type': 'application/cbor',
        'Accept': 'application/cbor',
        'Authorization': `Bearer ${apiKey}`
      }
    });
    expect(response.status()).toBe(400);
    const err = decodeCBOR(Buffer.from(await response.body()));
    expect(err.title).toBe('Bad Request');
  });
});