import type { APIResponse } from "@playwright/test";
import { decode as decodeCbor } from "cbor-x";

export type ProblemDetails = {
	type?: string;
	title?: string;
	status?: number;
	detail?: string;
	instance?: string;
	[key: string]: unknown;
};

export async function decodeProblemDetails(
	response: APIResponse,
): Promise<ProblemDetails | undefined> {
	if (response.status() < 400) {
		return undefined;
	}
	try {
		const body = await response.body();
		if (!body || body.length === 0) {
			return undefined;
		}
		return decodeCbor(body) as ProblemDetails;
	} catch {
		return undefined;
	}
}
