import { watch, type FSWatcher } from 'chokidar';
import * as fs from 'node:fs';
import type { EmitEventFn } from '../events/types.js';
import type { Observer } from './types.js';

export interface FileWatcherOptions {
  projectDir: string;
  projectId: string;
  publishEvent: EmitEventFn;
  ignoredPatterns?: Array<string | RegExp>;
  debounceMs?: number;
}

const DEFAULT_IGNORED: Array<string | RegExp> = [
  /node_modules/,
  /\.git/,
  /\.agentos/,
  /[/\\]dist[/\\]/,
  /[/\\]build[/\\]/,
  /\.next/,
  /\.nuxt/,
  /[/\\]coverage[/\\]/,
  /\.db$/,
  /\.db-journal$/,
];

type PendingChange = { type: 'file_created' | 'file_modified' | 'file_deleted'; path: string };

export class FileWatcher implements Observer {
  private watcher: FSWatcher | null = null;
  private pendingBatch: Map<string, PendingChange> = new Map();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private publishEvent: EmitEventFn;
  private projectDir: string;
  private projectId: string;
  private ignored: Array<string | RegExp>;

  constructor(opts: FileWatcherOptions) {
    this.publishEvent = opts.publishEvent;
    this.projectDir = opts.projectDir;
    this.projectId = opts.projectId;
    this.ignored = opts.ignoredPatterns ?? DEFAULT_IGNORED;
    this.debounceMs = opts.debounceMs ?? 200;
  }

  start(): void {
    this.watcher = watch(this.projectDir, {
      ignored: this.ignored,
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher.on('add', (filePath) => this.enqueue('file_created', filePath));
    this.watcher.on('change', (filePath) => this.enqueue('file_modified', filePath));
    this.watcher.on('unlink', (filePath) => this.enqueue('file_deleted', filePath));
  }

  async stop(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.flush();
    await this.watcher?.close();
    this.watcher = null;
  }

  private enqueue(type: PendingChange['type'], filePath: string): void {
    this.pendingBatch.set(filePath, { type, path: filePath });

    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    const batch = Array.from(this.pendingBatch.values());
    this.pendingBatch.clear();
    this.batchTimer = null;

    for (const item of batch) {
      const payload: Record<string, unknown> = { path: item.path };

      if (item.type !== 'file_deleted') {
        try {
          const stat = fs.statSync(item.path);
          payload.size = stat.size;
          payload.mtime = stat.mtime.toISOString();
        } catch {
          // File vanished between the chokidar event and our stat — treat as delete.
          this.publishEvent({
            source: 'fs',
            type: 'file_deleted',
            payload: { path: item.path },
            metadata: { project_id: this.projectId },
          });
          continue;
        }
      } else {
        payload.size = null;
        payload.mtime = null;
      }

      this.publishEvent({
        source: 'fs',
        type: item.type,
        payload,
        metadata: { project_id: this.projectId },
      });
    }
  }
}
