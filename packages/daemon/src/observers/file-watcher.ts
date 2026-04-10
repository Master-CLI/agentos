import { watch, type FSWatcher } from 'chokidar';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventBus } from '../events/event-bus.js';
import type { ProjectEvent } from '../events/types.js';
import type { Observer } from './types.js';

export interface FileWatcherOptions {
  projectDir: string;
  projectId: string;
  eventBus: EventBus;
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

export class FileWatcher implements Observer {
  private watcher: FSWatcher | null = null;
  private pendingBatch: Map<string, { type: string; path: string }> = new Map();
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private eventBus: EventBus;
  private projectDir: string;
  private projectId: string;
  private ignored: Array<string | RegExp>;

  constructor(opts: FileWatcherOptions) {
    this.eventBus = opts.eventBus;
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

  stop(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.flush();
    this.watcher?.close();
    this.watcher = null;
  }

  private enqueue(type: string, filePath: string): void {
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
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(item.path);
      } catch {
        // File may have been deleted
      }

      const event: Omit<ProjectEvent, 'id' | 'timestamp'> = {
        source: 'fs',
        type: item.type,
        payload: {
          path: item.path,
          size: stat?.size ?? null,
          mtime: stat?.mtime?.toISOString() ?? null,
        },
        metadata: { project_id: this.projectId },
      };

      this.eventBus.publish(event as ProjectEvent);
    }
  }
}
