import { encode as encodeCbor } from 'cbor-x';

export const CBOR_MIME = 'application/cbor';

export function cborResponse(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
	return new Response(encodeCbor(data), {
		status,
		headers: {
			'content-type': CBOR_MIME,
			...extraHeaders
		}
	});
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
