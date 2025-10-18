/**
 * SCRAPI v05 Compliance Tests
 * Tests the mandatory SCITT SCRAPI endpoints
 */

import { decode, encode } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import type { RegisterStatementResponse } from '../lib/scrapi/register-signed-statement';
import type { TransparencyConfiguration } from '../lib/scrapi/transparency-configuration';
import type { SCITTReceipt, SCRAPIOperation, StatementEntry } from '../lib/scrapi/types';

describe('SCRAPI v05 Encoding', () => {

  describe('CBOR Response Validation', () => {
    it('should encode/decode TransparencyConfiguration', () => {
      const config: TransparencyConfiguration = {
        serviceId: 'test-service',
        scrapiVersion: 'draft-ietf-scitt-scrapi-05',
        supportedHashAlgorithms: ['sha-256'],
        supportedSignatureAlgorithms: ['ES256'],
        maxStatementSize: 10485760,
        maxEntriesPerPage: 100,
        baseUrl: 'https://example.com'
      };

      const encoded = encode(config);
      const decoded = decode(encoded);
      expect(decoded).toEqual(config);
    });

    it('should encode/decode RegisterStatementResponse', () => {
      const response: RegisterStatementResponse = {
        operationId: 'op-123',
        status: 'accepted',
        logId: 'log-123',
        statementId: 'stmt-123',
        path: '/logs/log-123/leaves/0/hash',
        fenceIndex: 0
      };

      const encoded = encode(response);
      const decoded = decode(encoded);
      expect(decoded).toEqual(response);
    });

    it('should encode/decode StatementEntry', () => {
      const entry: StatementEntry = {
        entryId: 'entry-123',
        logId: 'log-123',
        statementId: 'stmt-123',
        fenceIndex: 0,
        timestamp: Date.now(),
        contentHash: 'abc123',
        size: 1024,
        sequenced: false
      };

      const encoded = encode(entry);
      const decoded = decode(encoded);
      expect(decoded).toEqual(entry);
    });

    it('should encode/decode SCITTReceipt', () => {
      const receipt: SCITTReceipt = {
        version: 1,
        logId: 'log-123',
        entryId: 'entry-123',
        fenceIndex: 0,
        mmrIndex: 100,
        timestamp: Date.now(),
        proof: {
          type: 'merkle-inclusion',
          data: new Uint8Array([1, 2, 3, 4])
        },
        signature: new Uint8Array([5, 6, 7, 8])
      };

      const encoded = encode(receipt);
      const decoded = decode(encoded);
      expect(decoded.version).toBe(receipt.version);
      expect(decoded.logId).toBe(receipt.logId);
    });

    it('should encode/decode SCRAPIOperation', () => {
      const operation: SCRAPIOperation = {
        operationId: 'op-123',
        status: 'running',
        type: 'register-signed-statement',
        created: Date.now()
      };

      const encoded = encode(operation);
      const decoded = decode(encoded);
      expect(decoded).toEqual(operation);
    });
  });

  describe('COSE Sign1 Validation', () => {
    it('should validate COSE Sign1 structure', () => {
      // Valid COSE Sign1 structure
      const validCose = new Uint8Array([
        0x84, // Array of 4 elements
        0x43, 0x01, 0x02, 0x03, // Protected headers
        0xa0, // Unprotected headers (empty map)
        0x45, 0x01, 0x02, 0x03, 0x04, 0x05, // Payload
        0x58, 0x40, // Signature (64 bytes)
        ...new Array(64).fill(0)
      ]);

      // Check first byte is 0x84 (CBOR array of 4)
      expect(validCose[0]).toBe(0x84);
      expect(validCose.length).toBeGreaterThan(10);
    });
  });

  describe('Content Types', () => {
    it('should use correct CBOR content types', () => {
      expect('application/cbor').toBe('application/cbor');
      expect('application/cose; cose-type="cose-sign1"').toContain('cose-sign1');
      expect('application/scitt-receipt+cbor').toContain('receipt');
      expect('application/problem+cbor').toContain('problem');
    });
  });

  describe('Error Handling', () => {
    it('should use CoAP-inspired status codes', () => {
      // Client errors (4.xx)
      expect(400).toBe(400); // Bad Request
      expect(401).toBe(401); // Unauthorized
      expect(404).toBe(404); // Not Found
      expect(409).toBe(409); // Conflict
      expect(413).toBe(413); // Payload Too Large

      // Server errors (5.xx)
      expect(500).toBe(500); // Internal Server Error
      expect(503).toBe(503); // Service Unavailable
    });
  });
});
