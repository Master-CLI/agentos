import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventStore } from '../events/event-store.js';
import type { EventBus } from '../events/event-bus.js';
import type { ProjectEvent } from '../events/types.js';
import { detectModules } from './module-detector.js';

/**
 * Version for the on-disk checkpoint file format.
 * Bump this whenever ProjectSnapshot's shape changes in an incompatible way.
 * A mismatched version triggers a full replay so the checkpoint is transparently
 * regenerated on next stop().
 */
const SNAPSHOT_SCHEMA_VERSION = 1;

interface SnapshotCheckpoint {
  schemaVersion: number;
  last_event_id: string;
  snapshot: ProjectSnapshot;
}

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
    private checkpointPath?: string,
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
   *
   * If a valid checkpoint exists at `checkpointPath` (matching schemaVersion),
   * loads the checkpoint and replays only delta events (afterId). Any failure
   * during checkpoint load falls back silently to a full replay, so correctness
   * is always guaranteed.
   */
  async rebuild(): Promise<void> {
    await this.eventStore.ensureReady();

    let loadedFromCheckpoint = false;

    if (this.checkpointPath) {
      try {
        const raw = fs.readFileSync(this.checkpointPath, 'utf-8');
        const checkpoint = JSON.parse(raw) as unknown;
        if (
          checkpoint !== null &&
          typeof checkpoint === 'object' &&
          'schemaVersion' in checkpoint &&
          (checkpoint as SnapshotCheckpoint).schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
          'last_event_id' in checkpoint &&
          typeof (checkpoint as SnapshotCheckpoint).last_event_id === 'string' &&
          'snapshot' in checkpoint
        ) {
          const cp = checkpoint as SnapshotCheckpoint;
          this.snapshot = cp.snapshot as ProjectSnapshot;
          // Replay only the delta events appended since the checkpoint.
          const delta = this.eventStore.query({ afterId: cp.last_event_id });
          for (const event of delta) {
            this.applyEvent(event);
          }
          loadedFromCheckpoint = true;
        }
      } catch { /* corrupt / missing / parse error → fall through to full replay */ }
    }

    if (!loadedFromCheckpoint) {
      const events = this.eventStore.query({});
      this.snapshot = this.emptySnapshot();
      for (const event of events) {
        this.applyEvent(event);
      }
    }

    // Re-run module detection after any rebuild path — detection failure is non-fatal.
    if (this.projectDir) {
      try {
        this.snapshot.modules = detectModules(this.projectDir);
      } catch { /* detection failure is non-fatal */ }
    }
  }

  /**
   * Atomically persist the current snapshot to the checkpoint file.
   * Uses a temp-file + rename pattern so readers never see a partial write.
   * Called by the daemon in stop(); interval-based persist can be added later.
   */
  persist(): void {
    if (!this.checkpointPath) return;
    try {
      const checkpoint: SnapshotCheckpoint = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        last_event_id: this.snapshot.last_event_id,
        snapshot: this.snapshot,
      };
      const dir = path.dirname(this.checkpointPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      // Temp file MUST live in the SAME directory as the target so the rename is
      // a same-filesystem atomic move. os.tmpdir() can be a different drive
      // (e.g. C: temp vs D: project on Windows), which makes renameSync throw
      // EXDEV and silently defeat the checkpoint entirely.
      const tmp = path.join(dir, `.snapshot-${process.pid}-${Date.now()}.json.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(checkpoint), 'utf-8');
      fs.renameSync(tmp, this.checkpointPath);
    } catch { /* persist failure is non-fatal; next rebuild will do a full replay */ }
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
