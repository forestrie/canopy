# Subplan 03 (superseded): Ranger — authority log leaf append

**Status**: SUPERSEDED  
**Date**: 2026-03-09  
**Superseded by**: [Subplan 03: Grant-sequencing component](subplan-03-grant-sequencing-component.md)

Ranger is **explicitly excluded** from changes for the grants implementation. Ranger has no opinion on which logs to extend; it just extends the log it is asked to extend.

The work of getting the grant leaf into the authority log MMR is done by a **grant-sequencing component** that completes the work started by register-grant. That component produces entries in the **existing** format ranger already consumes and injects them into the pipeline ranger reads from. In the current subplan, ranger has one optional, config-driven change: idtimestamps in the batch ack when configured (see current subplan §7.1).

See the current subplan: [subplan-03-grant-sequencing-component.md](subplan-03-grant-sequencing-component.md).
