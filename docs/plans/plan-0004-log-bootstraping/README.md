# Plan 0004: Log bootstrapping — overview and subplans

This directory contains the **overview** and **agent-optimised subplans** for authority log bootstrap and grant issuance (Plan 0004).

- **[overview.md](overview.md)** — Key outcomes, deliverables, summary of each subplan, build order, and refinement questions for agentic implementation.

**Subplans** (independently buildable; each has scope, dependencies, inputs/outputs, verification, references):

| # | Subplan |
|---|---------|
| 01 | [Shared encoding and univocity alignment](subplan-01-shared-encoding-univocity-alignment.md) |
| 02 | [REST auth log status and log type service](subplan-02-rest-auth-log-status.md) |
| 03 | [Ranger: authority log leaf append](subplan-03-ranger-authority-leaf-append.md) |
| 04 | [Signer: delegation for bootstrap and parent log](subplan-04-signer-delegation-bootstrap-and-parent.md) |
| 05 | [Queue consumer: grant-issuance service](subplan-05-queue-consumer-grant-issuance.md) |
| 06 | [Canopy: settlement to issue-grant queue](subplan-06-canopy-settlement-to-issue-grant-queue.md) |
| 07 | [Sealer: key resolution per log](subplan-07-sealer-key-resolution-per-log.md) |
