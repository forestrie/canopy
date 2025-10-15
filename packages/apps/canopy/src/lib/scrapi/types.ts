export type ScrapiOperationStatus = 'running' | 'succeeded' | 'failed';

export interface ScrapiOperationError {
	code?: string;
	message: string;
}

export interface ScrapiOperation {
	operationId: string;
	status: ScrapiOperationStatus;
	type: 'register-signed-statement' | string;
	created: number;
	completed?: number;
	error?: ScrapiOperationError;
}

export interface TransparencyConfiguration {
	version: string;
	service: string;
	baseUrl: string;
	capabilities: {
		contentTypes: string[];
		statementFormats: string[];
		maxStatementSize: number;
	};
	endpoints: Record<string, string>;
}
