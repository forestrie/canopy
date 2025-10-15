import { ClientErrors } from './problem-details';

export function validateUUID(id: string | undefined): Response | null {
	if (!id) return ClientErrors.badRequest('Missing id');
	const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
	return ok ? null : ClientErrors.badRequest('id must be a UUID');
}

export function validateOperationId(id: string | undefined): Response | null {
	return validateUUID(id);
}
