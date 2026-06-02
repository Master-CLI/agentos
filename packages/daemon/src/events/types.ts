/**
 * Schema version for ProjectEvent.
 *
 * Increment this when the event shape changes in a backward-incompatible way.
 * A future `migrateEvent(event)` function would switch on `event.version` and
 * upcast older rows to the current shape before they reach the snapshot engine.
 * For now, version 1 is the baseline; all new events are stamped with
 * CURRENT_EVENT_VERSION at append time.
 */
export const CURRENT_EVENT_VERSION = 1;

export interface ProjectEvent {
  id: string;
  timestamp: string;
  /** Schema version of this event record (default 1). Used by a future upcaster. */
  version: number;
  source: string;
  type: string;
  payload: Record<string, unknown>;
  metadata: {
    project_id: string;
    correlation_id?: string;
  };
}

/**
 * Single entry point for event ingress.
 *
 * Call this from observers and managers with a partial event (no id/timestamp);
 * the daemon-wired implementation persists to the event store and fans out to
 * the bus in one step. Returns the fully-populated event so callers can use
 * its `id` for correlation.
 *
 * Tests that don't need persistence can pass a bus-only shim (see
 * `makeBusEmitter` in tests).
 */
export type EmitEventFn = (event: Omit<ProjectEvent, 'id' | 'timestamp' | 'version'>) => ProjectEvent;
