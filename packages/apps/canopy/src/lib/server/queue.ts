/**
 * Cloudflare Queue utilities for sequencer integration
 */
import type { Queue } from '@cloudflare/workers-types';

export interface SequencerMessage {
	logId: string;
	statementPath: string;
	contentHash: string;
	fenceIndex: number;
	timestamp: number;
	forestProjectId: string;
}

/**
 * Submit a statement to the sequencer queue
 *
 * @param queue The Cloudflare Queue
 * @param message The sequencer message
 * @returns The message ID
 */
export async function submitToSequencer(
	queue: Queue,
	message: SequencerMessage
): Promise<string> {
	// Generate a unique message ID
	const messageId = crypto.randomUUID();

	// Send to queue with message ID
	await queue.send({
		id: messageId,
		...message
	});

	console.log(`[Queue] Submitted message ${messageId} for sequencing`);
	return messageId;
}

/**
 * Create a sequencer message from statement details
 *
 * @param logId The log identifier
 * @param statementPath The R2 storage path
 * @param contentHash The content hash
 * @param fenceIndex The fence MMR index
 * @param forestProjectId The forest project ID
 * @returns The sequencer message
 */
export function createSequencerMessage(
	logId: string,
	statementPath: string,
	contentHash: string,
	fenceIndex: number,
	forestProjectId: string
): SequencerMessage {
	return {
		logId,
		statementPath,
		contentHash,
		fenceIndex,
		timestamp: Date.now(),
		forestProjectId
	};
}