## Event Sourcing

This project treats the event log as the source of truth. State in memory is a projection; state on disk is the event stream.

**Rules**:
- Every state change goes through the single ingress (`appendAndPublish` or equivalent). Direct in-memory mutations that skip the log are regressions.
- Managers (Suggestion / Task / Initiative / etc.) expose a `replay(events)` method that reconstructs in-memory state from the log on cold start.
- Event schemas are additive. Removing or renaming a field breaks replay for existing databases — if you need to evolve, add a new event type and leave the old one handled in replay.
- Payloads should be fully self-describing (include the whole entity on `*_created`, not just an id). Replay should not need external lookups.

**When you touch a manager**:
- Adding a new mutation? Add a new event type + a `replay` case for it.
- Changing an existing mutation? Make sure existing events in the log still replay correctly (old field semantics preserved).
- Testing? Construct the manager without an `emit` hook for unit tests (no persistence needed), and test `replay()` separately with synthesized events.
