# ADR Process

## What Are ADRs?

Architecture Decision Records (ADRs) document significant architectural
decisions and their rationale. They serve as a historical record of why
choices were made, helping future developers understand the context
behind design decisions.

## Format

### File Naming

- **Standard ADRs**: `adr-{NUMBER}-{short-name}.md`
- **Security-critical ADRs**: `adr-{NUMBER}-sec-{short-name}.md`

The number is sequential. Short names are lowercase with hyphens.

### Line Length

All ADR documents must be formatted with a maximum line length of 79
characters. This ensures readability in standard terminal windows and
maintains consistency across all documentation.

### Document Structure

Each ADR includes:

**Header**:
- **Status**: Current state of the decision (see Status values below)
- **Date**: When the ADR was created or last updated
- **Categories**: Relevant areas (e.g., `[WALLET, PAYEMENTS, UX,
  SECURITY]`)

**Sections**:
- **Context**: Why this decision is needed, what problem it solves
- **Decision**: The chosen approach and brief rationale
- **Consequences**: Positive and negative impacts, trade-offs
- **Implementation**: How to implement the decision (if applicable)
- **Alternative Considered**: Other options evaluated and why they were
  rejected
- **References**: Links to related code, documents, or other ADRs

## Status Values

### ACCEPTED
All stakeholders are fully bought in and the decision applies to
current production engineering. The decision is being implemented or
already implemented. A key consideration for weight of deliberation is
how reversible the choice is. If its easily reversible without
significant user or business impact, then a light touch is fine.

### READY
Engineering stakeholders (or suitable point person) are willing to
proceed at risk, or believe that implementation at risk is the way to
finalize the choices. The decision is sound enough to proceed, but may
evolve during implementation. Engineering are accountable for effort
wasted due to lack of stakeholder engagement.

### DISCUSS
The proposal is actively being considered. Stakeholders are reviewing,
debating, or gathering information. Implementation prototypes may
proceed but only if the support decision making. Significant investment
of implementation effort should not precede READY.

### REJECTED
For whatever reason, the proposal and implied choice is completely
rejected. Documented for historical record to avoid revisiting rejected
approaches.

### HISTORICAL
No longer relevant to production code. The decision may have been
superseded, the feature removed, or the context fundamentally changed.
Kept for historical reference.

## Field Rationale

**Status**: Tracks decision lifecycle and current relevance
**Date**: Provides temporal context for when decisions were made
**Categories**: Enables filtering and finding related decisions
**Context**: Explains the problem space and constraints
**Decision**: Records the actual choice made
**Consequences**: Helps evaluate trade-offs and understand impacts
**Implementation**: Provides actionable guidance for developers
**Alternatives**: Explains why other paths weren't taken
**References**: Connects to code, docs, and related decisions
