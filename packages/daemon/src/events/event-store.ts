import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ulid } from 'ulid';
import type { ProjectEvent } from './types.js';

export class EventStore {
  private db!: Database;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        project_id TEXT NOT NULL,
        correlation_id TEXT
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`);

    this.save();
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

    this.db.run(
      `INSERT INTO events (id, timestamp, source, type, payload, project_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        full.id,
        full.timestamp,
        full.source,
        full.type,
        JSON.stringify(full.payload),
        full.metadata.project_id,
        full.metadata.correlation_id ?? null,
      ],
    );

    this.save();
    return full;
  }

  query(opts: { from?: string; to?: string; type?: string; limit?: number }): ProjectEvent[] {
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

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ? `LIMIT ${opts.limit}` : '';

    const stmt = this.db.prepare(
      `SELECT id, timestamp, source, type, payload, project_id, correlation_id
       FROM events ${where} ORDER BY timestamp ASC ${limit}`
    );
    stmt.bind(params);

    const results: ProjectEvent[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as {
        id: string;
        timestamp: string;
        source: string;
        type: string;
        payload: string;
        project_id: string;
        correlation_id: string | null;
      };
      results.push({
        id: row.id,
        timestamp: row.timestamp,
        source: row.source,
        type: row.type,
        payload: JSON.parse(row.payload),
        metadata: {
          project_id: row.project_id,
          correlation_id: row.correlation_id ?? undefined,
        },
      });
    }
    stmt.free();

    return results;
  }

  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as cnt FROM events');
    stmt.step();
    const result = stmt.getAsObject() as { cnt: number };
    stmt.free();
    return result.cnt;
  }

  save(): void {
    const data = this.db.export();
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  close(): void {
    this.save();
    this.db.close();
  }
}
