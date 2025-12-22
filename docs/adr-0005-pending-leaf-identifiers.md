# ADR: Embedding Snowflake IDs into UUIDv7 for Log Entries

## Status

Accepted

## Context

Forestrie Veracity uses a Snowflake-inspired identifier to assign a
cluster-unique, millisecond-precision identifier to every committed
entry in an append-only log.

The Snowflake ID has the following properties:

- 40 bits of millisecond time.
- 24 bits of non-time uniqueness.
  - These bits encode a worker discriminator derived from pod IP / CIDR.
  - They also encode a per-millisecond sequence counter.
- The generator guarantees strict monotonicity within a log.
- Uniqueness is guaranteed within the scope of a single log.

The system additionally uses UUIDs for external identifiers.

- A UUIDv4 identifies the log itself.
- A UUIDv7 may already exist for a "pre-sequenced" leaf.
  - This UUID reflects arrival or ingestion time.
- A new identifier is needed at commit time.
  - This identifier must reflect the commit ordering of the log.

The goal is to generate a standards-compliant UUIDv7 that:

- Embeds the full Snowflake ID.
- Allows exact recovery of the Snowflake ID.
- Preserves ordering by commit time.
- Does not introduce ambiguity at epoch boundaries.
- Avoids unnecessary duplication of semantics already present in UUIDv7.

Leaking worker identity and cluster topology through the UUID is
explicitly acceptable.

## Decision

We will generate a UUIDv7 at commit time that embeds the Snowflake ID,
using the following scheme.

### UUID Version and Timestamp

- The UUID version is UUIDv7.
- The UUIDv7 timestamp field (48 bits) is set to the Unix epoch
  millisecond timestamp of the commit time.

This timestamp is derived from the Snowflake time component by adding
the start time of the applicable Commitment Epoch.

The Commitment Epoch is recorded in the start header of each log
section and is therefore unambiguous for all writers and readers of
that section.

### Embedding the Snowflake Non-Time Bits

The 24-bit non-time component of the Snowflake ID is embedded directly
into the UUIDv7 "random" fields.

The layout is:

- `rand_a` (12 bits):
  - High 12 bits of the Snowflake non-time field.
- `rand_b` (62 bits):
  - High 12 bits: low 12 bits of the Snowflake non-time field.
  - Remaining 50 bits: entropy.

This allows exact recovery of the 24-bit Snowflake non-time value from
the UUID alone.

### Entropy Source

The remaining 50 bits of `rand_b` are populated using one of:

- A cryptographically secure random number generator, or
- A deterministic PRF or hash over:
  - The log UUIDv4.
  - The pre-sequenced UUIDv7, if present.
  - The full Snowflake ID.
  - A domain-separation constant.

The choice depends on whether deterministic linkage between the
pre-sequenced UUID and the committed UUID is required.

Both approaches provide sufficient entropy to avoid collisions beyond
the guarantees already provided by the Snowflake ID.

### Recovering the Snowflake ID

To recover the Snowflake ID:

1. Extract the 24-bit non-time value from `rand_a` and `rand_b`.
2. Read the Commitment Epoch from the relevant log section header.
3. Compute:
   - `snowflake_time_ms =
     uuid_unix_ms - epoch_start_unix_ms(commitment_epoch)`
4. Recombine the 40-bit time value and 24-bit non-time value.

This recovery is exact and unambiguous for all entries in the section.

### Epoch Boundary Handling

There is no ambiguity at Commitment Epoch boundaries because:

- The UUIDv7 timestamp is absolute Unix time.
- The applicable Commitment Epoch is defined by the log section header.
- All writers to a section agree on the epoch by construction.

Boundary cases are handled deterministically.

As a safety measure, implementations should validate that the recovered
Snowflake time falls within the expected range for the section.

Failure indicates incorrect context or corrupted metadata.

## Consequences

### Positive

- UUIDs are fully standards-compliant UUIDv7 values.
- Ordering by UUID matches commit-time ordering.
- The full Snowflake ID is exactly recoverable.
- No additional epoch bits are required in the UUID.
- The design cleanly separates:
  - Global time semantics (UUIDv7 timestamp).
  - Log-local ordering and uniqueness (Snowflake bits).
- The scheme is robust at epoch boundaries.

### Negative

- Worker identity and cluster topology are exposed in the UUID.
  - This is an explicit and accepted trade-off.
- Recovering the Snowflake ID requires access to section metadata.
  - UUIDs decoded in isolation cannot recover the Snowflake time.

## Alternatives Considered

### Encoding Commitment Epoch into the UUID

Rejected.

Encoding the epoch into UUID bits would reduce available entropy and
duplicate information already present in authenticated log metadata.

### Using UUIDv8 Instead of UUIDv7

Rejected.

UUIDv7 is appropriate because commit time can be expressed as Unix
milliseconds without loss of information.

UUIDv8 is reserved for cases where custom epoch semantics cannot be
mapped onto Unix time.

## References

- RFC 9562: Universally Unique IDentifiers (UUIDs).
- Forestrie `go-merklelog` Snowflake ID implementation.
- Snowflake ID design patterns and monotonic ID generators.

