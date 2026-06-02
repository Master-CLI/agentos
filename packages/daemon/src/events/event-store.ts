import Database, { type Database as DB } from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ProjectEvent } from './types.js';

// Monotonic ULID factory: ids generated for events within the same millisecond
// are strictly increasing, so `ORDER BY timestamp ASC, id ASC` reproduces causal
// (append) order exactly — a hard requirement for deterministic event-sourcing
// replay. Appends are synchronous and single-threaded, so this is causal-exact.
const ulid = monotonicFactory();

/**
 * Append-only event log backed by better-sqlite3.
 *
 * Synchronous API — each append is flushed to disk by the SQLite engine (WAL).
 * No full-file re-export per write (which is what sql.js forced us to do).
 */
export class EventStore {
  private db: DB;
  private insertStmt: Database.Statement;
  private ready: Promise<void>;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        project_id TEXT NOT NULL,
        correlation_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (id, timestamp, source, type, payload, project_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.ready = Promise.resolve();
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  append(event: Omit<ProjectEvent, 'id' | 'timestamp'>): ProjectEvent {
    const full: ProjectEvent = {
      id: ulid(),
      timestamp: new Date().toISOString(),
      ...event,
    };

    this.insertStmt.run(
      full.id,
      full.timestamp,
      full.source,
      full.type,
      JSON.stringify(full.payload),
      full.metadata.project_id,
      full.metadata.correlation_id ?? null,
    );

    return full;
  }

  query(opts: {
    from?: string;
    to?: string;
    type?: string;
    types?: string[];
    projectId?: string;
    limit?: number;
  }): ProjectEvent[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.from) {
      conditions.push('timestamp >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      conditions.push('timestamp <= ?');
      params.push(opts.to);
    }
    if (opts.type) {
      conditions.push('type = ?');
      params.push(opts.type);
    }
    if (opts.types && opts.types.length > 0) {
      conditions.push(`type IN (${opts.types.map(() => '?').join(',')})`);
      params.push(...opts.types);
    }
    if (opts.projectId) {
      conditions.push('project_id = ?');
      params.push(opts.projectId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ? `LIMIT ${opts.limit}` : '';

    const rows = this.db.prepare(
      `SELECT id, timestamp, source, type, payload, project_id, correlation_id
       FROM events ${where} ORDER BY timestamp ASC, id ASC ${limit}`,
    ).all(...params) as Array<{
      id: string;
      timestamp: string;
      source: string;
      type: string;
      payload: string;
      project_id: string;
      correlation_id: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      source: row.source,
      type: row.type,
      payload: JSON.parse(row.payload),
      metadata: {
        project_id: row.project_id,
        correlation_id: row.correlation_id ?? undefined,
      },
    }));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number };
    return row.cnt;
  }

  /** @deprecated — kept for API compatibility; better-sqlite3 auto-persists via WAL. */
  save(): void {
    // no-op
  }

  close(): void {
    this.db.close();
  }
}
