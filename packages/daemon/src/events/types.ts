export interface ProjectEvent {
  id: string;
  timestamp: string;
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
export type EmitEventFn = (event: Omit<ProjectEvent, 'id' | 'timestamp'>) => ProjectEvent;
