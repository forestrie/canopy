/**
 * Test helpers for mocking R2 in unit tests
 */
import type { R2Bucket, R2Object, R2PutOptions } from '@cloudflare/workers-types';
import { vi } from 'vitest';

/**
 * Create a mock R2 bucket for testing
 */
export function createMockR2Bucket(): R2Bucket {
  const storage = new Map<string, { data: ArrayBuffer; metadata: any }>();

  return {
    put: vi.fn(async (key: string, value: any, options?: R2PutOptions) => {
      const data = value instanceof ArrayBuffer ? value :
                   value instanceof Uint8Array ? value.buffer :
                   new TextEncoder().encode(value).buffer;

      storage.set(key, {
        data,
        metadata: {
          ...options?.httpMetadata,
          customMetadata: options?.customMetadata
        }
      });

      return {
        key,
        etag: `"${Math.random().toString(36).substr(2, 9)}"`,
        size: data.byteLength,
        uploaded: new Date(),
        httpMetadata: options?.httpMetadata || {},
        customMetadata: options?.customMetadata || {},
        checksums: {},
        storageClass: 'STANDARD'
      } as any;
    }),

    get: vi.fn(async (key: string) => {
      const stored = storage.get(key);
      if (!stored) return null;

      return {
        key,
        body: stored.data,
        arrayBuffer: async () => stored.data,
        text: async () => new TextDecoder().decode(stored.data),
        json: async () => JSON.parse(new TextDecoder().decode(stored.data)),
        blob: async () => new Blob([stored.data]),
        customMetadata: stored.metadata.customMetadata || {},
        httpMetadata: stored.metadata.httpMetadata || {},
        uploaded: new Date(),
        size: stored.data.byteLength,
        etag: `"${Math.random().toString(36).substr(2, 9)}"`
      } as any;
    }),

    list: vi.fn(async (options?: any) => {
      const prefix = options?.prefix || '';
      const limit = options?.limit || 1000;

      const objects: R2Object[] = [];
      for (const [key, value] of storage.entries()) {
        if (key.startsWith(prefix)) {
          objects.push({
            key,
            uploaded: new Date(),
            size: value.data.byteLength,
            etag: `"${Math.random().toString(36).substr(2, 9)}"`,
            storageClass: 'STANDARD'
          } as R2Object);
        }
      }

      return {
        objects: objects.slice(0, limit),
        truncated: objects.length > limit,
        cursor: objects.length > limit ? 'mock-cursor' : undefined
      } as any;
    }),

    delete: vi.fn(async (key: string) => {
      storage.delete(key);
    }),

    head: vi.fn(async (key: string) => {
      const stored = storage.get(key);
      if (!stored) return null;

      return {
        key,
        uploaded: new Date(),
        size: stored.data.byteLength,
        etag: `"${Math.random().toString(36).substr(2, 9)}"`,
        httpMetadata: stored.metadata.httpMetadata || {},
        customMetadata: stored.metadata.customMetadata || {},
        storageClass: 'STANDARD'
      } as any;
    })
  } as R2Bucket;
}

/**
 * Create a mock platform object for testing
 */
export function createMockPlatform(overrides?: Partial<App.Platform>) {
  return {
    env: {
      CANOPY_ID: 'canopy-test',
      FOREST_PROJECT_ID: 'forest-test',
      API_VERSION: 'v1',
      NODE_ENV: 'test',
      R2_WRITER: 'test-token',
      R2: createMockR2Bucket(),
      ...overrides?.env
    },
    context: {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn()
    },
    caches: {
      default: {
        match: vi.fn(),
        put: vi.fn(),
        delete: vi.fn()
      }
    },
    ...overrides
  } as App.Platform;
}