import { cborResponse } from './cbor-response';

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
	unsupportedMediaType: (detail?: string) => pd(415, 'Unsupported Media Type', detail),
	payloadTooLarge: (size: number, maxSize: number) =>
		pd(413, 'Payload Too Large', `Request size ${size} exceeds maximum ${maxSize} bytes`),
	invalidStatement: (detail?: string) => pd(400, 'Invalid Statement', detail),
	invalidOperationId: (operationId: string) =>
		pd(400, 'Invalid Operation ID', `Operation ID '${operationId}' is not in a valid format`)
};

export const ServerErrors = {
	internal: (detail?: string) => pd(500, 'Internal Server Error', detail),
	serviceUnavailable: (detail?: string) => pd(503, 'Service Unavailable', detail),
	storageError: (detail?: string, operation?: string) =>
		pd(500, 'Storage Error', operation ? `${operation}: ${detail}` : detail)
};
