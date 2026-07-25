/**
 * Univocity instance key normalization.
 *
 * An instance key names the univocity instance a log belongs to. It is the
 * account identity already carried on canopy's `RegistrationRecord`
 * `chainBinding { chainId, univocityAddr }`, rendered as `{chainId}:{addr}`.
 * The coordinator treats it as an opaque, case-insensitive label — it never
 * resolves it on chain — so the only rules here are the ones that keep it safe
 * in a URL path and as a SQLite primary key.
 *
 * See [ADR-0005 amendment](../../../../docs/adr/adr-0005-delegation-webhook-delivery.md)
 * "Instance-level webhooks, inherited by copy".
 */

/** Longest accepted instance key; chainId + 40-hex address fits easily. */
const MAX_INSTANCE_KEY_LENGTH = 128;

/** Alphanumeric plus the separators chain ids and CAIP-2 style ids use. */
const INSTANCE_KEY_PATTERN = /^[0-9a-z][0-9a-z._:-]*$/;

/** Raised when an instance key is empty, too long, or has stray characters. */
export class InstanceKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstanceKeyValidationError";
  }
}

/**
 * Normalize an instance key to its canonical lowercase form.
 *
 * @param raw - Instance key from a URL path or request body.
 * @returns Trimmed lowercase instance key.
 * @throws {InstanceKeyValidationError} When empty, over-long, or malformed.
 */
export function normalizeInstanceKey(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new InstanceKeyValidationError("instanceKey must not be empty");
  }
  if (trimmed.length > MAX_INSTANCE_KEY_LENGTH) {
    throw new InstanceKeyValidationError(
      `instanceKey must be at most ${MAX_INSTANCE_KEY_LENGTH} characters`,
    );
  }
  if (!INSTANCE_KEY_PATTERN.test(trimmed)) {
    throw new InstanceKeyValidationError(
      "instanceKey must be alphanumeric with '.', '_', ':' or '-' separators",
    );
  }
  return trimmed;
}
