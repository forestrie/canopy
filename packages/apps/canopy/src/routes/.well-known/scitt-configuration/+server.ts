import { cborResponse } from '$lib/scrapi/cborresponse';
import type { TransparencyConfiguration } from '$lib/scrapi/transparency-configuration';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, locals, platform }: { url: URL; locals: any; platform: any }) => {
	const cfg: TransparencyConfiguration = {
		version: platform?.env?.API_VERSION ?? 'v1',
		service: 'SCITT Transparency Service',
		baseUrl: url.origin,
		capabilities: {
			contentTypes: ['application/cbor'],
			statementFormats: ['cbor', 'cose-sign1'],
			maxStatementSize: 1_048_576
		},
		endpoints: {
			registerSignedStatement: '/api/v1/logs/{logId}/statements',
			transparencyServiceKeys: '/api/v1/keys'
		}
	};

	return cborResponse(cfg, 200, { 'cache-control': 'no-store' });
};
