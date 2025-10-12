import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import { encode as encodeCBOR } from 'cbor-x';

test.describe('Statements API', () => {
	const logId = uuidv4();
	const apiKey = 'test-api-key';

	test('POST /api/v1/logs/[logId]/statements accepts CBOR content', async ({ request }) => {
		const statement = {
			type: 'test-statement',
			data: 'test-data',
			timestamp: Date.now()
		};

		const cborContent = encodeCBOR(statement);

		const response = await request.post(`/api/v1/logs/${logId}/statements`, {
			data: cborContent,
			headers: {
				'Content-Type': 'application/cbor',
				'Authorization': `Bearer ${apiKey}`
			}
		});

		// Should return 202 Accepted for async processing
		expect(response.status()).toBe(202);

		const result = await response.json();
		expect(result).toHaveProperty('status', 'accepted');
		expect(result).toHaveProperty('logId', logId);
		expect(result).toHaveProperty('statementId');
		expect(result).toHaveProperty('path');
		expect(result).toHaveProperty('fenceIndex');
		expect(result).toHaveProperty('messageId');
	});

	test('POST /api/v1/logs/[logId]/statements accepts JSON content', async ({ request }) => {
		const statement = {
			type: 'test-statement',
			data: 'test-data',
			timestamp: Date.now()
		};

		const response = await request.post(`/api/v1/logs/${logId}/statements`, {
			data: statement,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			}
		});

		expect(response.status()).toBe(202);

		const result = await response.json();
		expect(result).toHaveProperty('status', 'accepted');
	});

	test('POST /api/v1/logs/[logId]/statements validates log ID format', async ({ request }) => {
		const invalidLogId = 'not-a-uuid';
		const statement = { test: 'data' };

		const response = await request.post(`/api/v1/logs/${invalidLogId}/statements`, {
			data: statement,
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			}
		});

		expect(response.status()).toBe(400);

		const error = await response.json();
		expect(error).toHaveProperty('error', 'Invalid log ID format');
	});

	test('GET /api/v1/logs/[logId]/statements lists statements', async ({ request }) => {
		const response = await request.get(`/api/v1/logs/${logId}/statements`, {
			headers: {
				'Authorization': `Bearer ${apiKey}`
			}
		});

		expect(response.ok()).toBeTruthy();

		const result = await response.json();
		expect(result).toHaveProperty('logId', logId);
		expect(result).toHaveProperty('statements');
		expect(Array.isArray(result.statements)).toBeTruthy();
	});

	test('Unauthorized request returns 401', async ({ request }) => {
		const response = await request.get(`/api/v1/logs/${logId}/statements`);

		expect(response.status()).toBe(401);
		expect(response.headers()['www-authenticate']).toBe('Bearer realm="api"');
	});
});