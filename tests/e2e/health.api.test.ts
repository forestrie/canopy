import { test, expect } from '@playwright/test';

test.describe('Health API', () => {
	test('GET /api/health returns healthy status', async ({ request }) => {
		const response = await request.get('/api/health');

		expect(response.ok()).toBeTruthy();
		expect(response.status()).toBe(200);

		const health = await response.json();
		expect(health).toHaveProperty('status', 'healthy');
		expect(health).toHaveProperty('timestamp');
		expect(health).toHaveProperty('forestProjectId');
		expect(health).toHaveProperty('services');
	});
});