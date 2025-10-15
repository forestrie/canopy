import { cborResponse } from './cbor';

function pd(status: number, title: string, detail?: string) {
	const body: Record<string, unknown> = { type: 'about:blank', title, status };
	if (detail) body.detail = detail;
	return cborResponse(body, status);
}

export const ClientErrors = {
	badRequest: (detail?: string) => pd(400, 'Bad Request', detail),
	unauthorized: (detail?: string, headers?: HeadersInit) =>
		cborResponse({ type: 'about:blank', title: 'Unauthorized', status: 401, detail }, 401, headers),
	forbidden: (detail?: string) => pd(403, 'Forbidden', detail),
	notFound: (what?: string, detail?: string) => pd(404, `${what ?? 'Not Found'}`, detail),
	notAcceptable: (detail?: string) => pd(406, 'Not Acceptable', detail),
	conflict: (detail?: string) => pd(409, 'Conflict', detail),
	unsupportedMediaType: (detail?: string) => pd(415, 'Unsupported Media Type', detail)
};

export const ServerErrors = {
	internal: (detail?: string) => pd(500, 'Internal Server Error', detail),
	serviceUnavailable: (detail?: string) => pd(503, 'Service Unavailable', detail)
};
