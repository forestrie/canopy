/**
 * Tests for R2 storage utilities
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { storeLeaf, getLeafObject, buildLeafPath, listLeaves } from './r2';
import { createMockR2Bucket } from '../test-helpers/r2-mock';
import type { R2Bucket } from '@cloudflare/workers-types';

describe('R2 Storage Utilities', () => {
  let mockBucket: R2Bucket;

  beforeEach(() => {
    mockBucket = createMockR2Bucket();
  });

  describe('storeLeaf', () => {
    it('should store a leaf with proper metadata', async () => {
      const content = new TextEncoder().encode('Hello World');
      const logId = 'test-log-123';
      const fenceIndex = 0;

      const result = await storeLeaf(
        mockBucket,
        logId,
        fenceIndex,
        content.buffer,
        'application/cbor'
      );

      expect(result).toHaveProperty('path');
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('etag');

      // Verify the path format
      expect(result.path).toMatch(/^logs\/test-log-123\/leaves\/0\/[a-f0-9]{32}$/);

      // Verify put was called
      expect(mockBucket.put).toHaveBeenCalledWith(
        result.path,
        expect.any(Uint8Array),
        expect.objectContaining({
          httpMetadata: expect.objectContaining({
            contentType: 'application/cbor'
          }),
          customMetadata: expect.objectContaining({
            logId: 'test-log-123',
            fenceIndex: '0'
          })
        })
      );
    });

    it('should handle ArrayBuffer serialization properly', async () => {
      // Test with raw ArrayBuffer (the issue we fixed)
      const buffer = new ArrayBuffer(10);
      const view = new Uint8Array(buffer);
      view.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      const result = await storeLeaf(
        mockBucket,
        'test-log',
        1,
        buffer,
        'application/cose'
      );

      expect(result).toHaveProperty('path');
      expect(result.hash).toBeTruthy();

      // The put method should have been called with Uint8Array, not ArrayBuffer
      const putCall = (mockBucket.put as any).mock.calls[0];
      expect(putCall[1]).toBeInstanceOf(Uint8Array);
    });
  });

  describe('getLeafObject', () => {
    it('should retrieve a stored leaf', async () => {
      // First store a leaf
      const content = new TextEncoder().encode('Test Content');
      const logId = 'test-log';
      const fenceIndex = 5;

      const storeResult = await storeLeaf(
        mockBucket,
        logId,
        fenceIndex,
        content.buffer,
        'application/cbor'
      );

      // Now retrieve it
      const retrieved = await getLeafObject(mockBucket, storeResult.path);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.metadata).toMatchObject({
        logId,
        fenceIndex,
        contentType: 'application/cbor',
        sequenced: false
      });

      // Content should match
      const retrievedText = new TextDecoder().decode(retrieved?.content);
      expect(retrievedText).toBe('Test Content');
    });

    it('should return null for non-existent path', async () => {
      const result = await getLeafObject(mockBucket, 'non/existent/path');
      expect(result).toBeNull();
    });
  });

  describe('buildLeafPath', () => {
    it('should build correct path format', () => {
      const path = buildLeafPath('my-log-id', 42, 'abc123def456');
      expect(path).toBe('logs/my-log-id/leaves/42/abc123def456');
    });
  });

  describe('listLeaves', () => {
    it('should list leaves for a log', async () => {
      // Store multiple leaves
      const logId = 'test-log';

      await storeLeaf(mockBucket, logId, 0, new ArrayBuffer(10), 'application/cbor');
      await storeLeaf(mockBucket, logId, 0, new ArrayBuffer(20), 'application/cbor');
      await storeLeaf(mockBucket, logId, 1, new ArrayBuffer(30), 'application/cbor');

      // List all leaves for the log
      const result = await listLeaves(mockBucket, logId);

      expect(result.objects).toHaveLength(3);
      expect(result.cursor).toBeUndefined(); // No pagination needed
    });

    it('should filter by fence index', async () => {
      const logId = 'test-log';

      await storeLeaf(mockBucket, logId, 0, new ArrayBuffer(10), 'application/cbor');
      await storeLeaf(mockBucket, logId, 0, new ArrayBuffer(20), 'application/cbor');
      await storeLeaf(mockBucket, logId, 1, new ArrayBuffer(30), 'application/cbor');

      // List only fence index 0
      const result = await listLeaves(mockBucket, logId, 0);

      expect(result.objects).toHaveLength(2);
      expect(result.objects.every(obj =>
        obj.key.includes('/leaves/0/')
      )).toBe(true);
    });
  });
});