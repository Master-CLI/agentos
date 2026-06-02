import type { EventStore } from '../events/event-store.js';
import type { EventBus } from '../events/event-bus.js';
import type { ProjectEvent } from '../events/types.js';
import { detectModules } from './module-detector.js';

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

const FILE_EVENT_COUNT_CAP = 2000;

export class SnapshotEngine {
  private snapshot: ProjectSnapshot;
  private unsubscribe?: () => void;

  constructor(
    private projectId: string,
    private eventStore: EventStore,
    private eventBus: EventBus,
    private projectDir?: string,
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
    // Populate modules after rebuild — detection failure must not break replay.
    if (this.projectDir) {
      try {
        this.snapshot.modules = detectModules(this.projectDir);
      } catch { /* detection failure is non-fatal */ }
    }
  }

  getSnapshot(): ProjectSnapshot {
    // Compute events_last_hour on each read so the value decays naturally.
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const recentEvents = this.eventStore.query({ from: oneHourAgo });
    return {
      ...this.snapshot,
      computed_at: new Date().toISOString(),
      metrics: {
        ...this.snapshot.metrics,
        events_last_hour: recentEvents.length,
      },
    };
  }

  private applyEvent(event: ProjectEvent): void {
    this.snapshot.version++;
    this.snapshot.last_event_id = event.id;
    this.snapshot.metrics.total_events++;
    // events_last_hour is now computed on-read in getSnapshot(); no increment here.

    if (event.source === 'fs') {
      const filePath = String(event.payload.path ?? '');
      const alreadyTracked = filePath in this.snapshot.file_event_counts;
      // Only add a NEW key if we haven't hit the soft cap.
      if (alreadyTracked || Object.keys(this.snapshot.file_event_counts).length < FILE_EVENT_COUNT_CAP) {
        this.snapshot.file_event_counts[filePath] =
          (this.snapshot.file_event_counts[filePath] ?? 0) + 1;
      }
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
