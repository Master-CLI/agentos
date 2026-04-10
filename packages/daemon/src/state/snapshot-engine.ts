import type { EventStore } from '../events/event-store.js';
import type { EventBus } from '../events/event-bus.js';
import type { ProjectEvent } from '../events/types.js';

export interface ModuleInfo {
  name: string;
  path: string;
  dependencies: string[];
}

export interface ProjectSnapshot {
  project_id: string;
  computed_at: string;
  version: number;
  last_event_id: string;
  modules: ModuleInfo[];
  file_event_counts: Record<string, number>;
  recent_commits: Array<{ hash: string; message: string; date: string }>;
  metrics: {
    total_events: number;
    events_last_hour: number;
    active_files: number;
  };
}

export class SnapshotEngine {
  private snapshot: ProjectSnapshot;
  private unsubscribe?: () => void;

  constructor(
    private projectId: string,
    private eventStore: EventStore,
    private eventBus: EventBus,
  ) {
    this.snapshot = this.emptySnapshot();
  }

  start(): void {
    // Subscribe to new events and update snapshot incrementally
    this.unsubscribe = this.eventBus.subscribe((event) => {
      this.applyEvent(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /**
   * Rebuild snapshot from event store (used on cold start).
   */
  async rebuild(): Promise<void> {
    await this.eventStore.ensureReady();
    const events = this.eventStore.query({});
    this.snapshot = this.emptySnapshot();
    for (const event of events) {
      this.applyEvent(event);
    }
  }

  getSnapshot(): ProjectSnapshot {
    return { ...this.snapshot, computed_at: new Date().toISOString() };
  }

  private applyEvent(event: ProjectEvent): void {
    this.snapshot.version++;
    this.snapshot.last_event_id = event.id;
    this.snapshot.metrics.total_events++;

    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    if (event.timestamp >= oneHourAgo) {
      this.snapshot.metrics.events_last_hour++;
    }

    if (event.source === 'fs') {
      const filePath = String(event.payload.path ?? '');
      this.snapshot.file_event_counts[filePath] =
        (this.snapshot.file_event_counts[filePath] ?? 0) + 1;
      this.snapshot.metrics.active_files = Object.keys(this.snapshot.file_event_counts).length;
    }

    if (event.type === 'commit_pushed') {
      this.snapshot.recent_commits.unshift({
        hash: String(event.payload.hash ?? ''),
        message: String(event.payload.message ?? ''),
        date: String(event.payload.date ?? event.timestamp),
      });
      // Keep only last 20 commits
      if (this.snapshot.recent_commits.length > 20) {
        this.snapshot.recent_commits = this.snapshot.recent_commits.slice(0, 20);
      }
    }
  }

  private emptySnapshot(): ProjectSnapshot {
    return {
      project_id: this.projectId,
      computed_at: new Date().toISOString(),
      version: 0,
      last_event_id: '',
      modules: [],
      file_event_counts: {},
      recent_commits: [],
      metrics: {
        total_events: 0,
        events_last_hour: 0,
        active_files: 0,
      },
    };
  }
}
