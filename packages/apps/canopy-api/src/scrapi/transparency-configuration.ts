/**
 * SCITT Transparency Configuration
 * Implements the well-known configuration endpoint
 */

/**
 * SCITT Transparency Configuration
 * Returned by /.well-known/scitt-configuration
 */
export interface TransparencyConfiguration {
  /** Service identifier */
  serviceId: string;
  /** Version of the SCRAPI specification implemented */
  scrapiVersion: string;
  /** Supported hash algorithms */
  supportedHashAlgorithms: string[];
  /** Supported signature algorithms */
  supportedSignatureAlgorithms: string[];
  /** Maximum statement size in bytes */
  maxStatementSize: number;
  /** Maximum entries per page for list operations */
  maxEntriesPerPage: number;
  /** Base URL for the service */
  baseUrl: string;
  /** Service metadata */
  metadata?: {
    /** Human-readable service name */
    name?: string;
    /** Service description */
    description?: string;
    /** Contact information */
    contact?: string;
  };
}

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  scrapiVersion: 'draft-ietf-scitt-scrapi-05',
  supportedHashAlgorithms: ['sha-256', 'sha-384', 'sha-512'],
  supportedSignatureAlgorithms: ['ES256', 'ES384', 'ES512', 'RS256', 'RS384', 'RS512'],
  maxStatementSize: 4 * 1024 * 1024, // 10MB
  maxEntriesPerPage: 100
} as const;

/**
 * Get transparency configuration for a service
 */
export function getTransparencyConfiguration(
  serviceId: string,
  baseUrl: string,
  metadata?: {
    name?: string;
    description?: string;
    contact?: string;
  }
): TransparencyConfiguration {
  return {
    serviceId,
    scrapiVersion: DEFAULT_CONFIG.scrapiVersion,
    supportedHashAlgorithms: [...DEFAULT_CONFIG.supportedHashAlgorithms],
    supportedSignatureAlgorithms: [...DEFAULT_CONFIG.supportedSignatureAlgorithms],
    maxStatementSize: DEFAULT_CONFIG.maxStatementSize,
    maxEntriesPerPage: DEFAULT_CONFIG.maxEntriesPerPage,
    baseUrl,
    metadata
  };
}

/**
 * Validate if a hash algorithm is supported
 */
export function isHashAlgorithmSupported(algorithm: string): boolean {
  return DEFAULT_CONFIG.supportedHashAlgorithms.includes(algorithm.toLowerCase() as any);
}

/**
 * Validate if a signature algorithm is supported
 */
export function isSignatureAlgorithmSupported(algorithm: string): boolean {
  return DEFAULT_CONFIG.supportedSignatureAlgorithms.includes(algorithm.toUpperCase() as any);
}

/**
 * Get maximum statement size
 */
export function getMaxStatementSize(): number {
  return DEFAULT_CONFIG.maxStatementSize;
}

/**
 * Get maximum entries per page
 */
export function getMaxEntriesPerPage(): number {
  return DEFAULT_CONFIG.maxEntriesPerPage;
}
