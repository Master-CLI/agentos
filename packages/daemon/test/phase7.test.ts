/**
 * Phase 7 tests — closing the confidence-calibration loop (P1-6),
 * TaskManager replay on restart (P1-7), deterministic replay ordering (P1-8),
 * snapshot.modules population (P1-10), events_last_hour decay (P1-11),
 * and file_event_counts soft cap (P2-4).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from 'ulid';
import type { Database as DB } from 'better-sqlite3';
import { EventStore } from '../src/events/event-store.js';
import { EventBus } from '../src/events/event-bus.js';
import { SnapshotEngine } from '../src/state/snapshot-engine.js';
import { ConfidenceCalibrator } from '../src/trust/confidence-calibrator.js';
import { Daemon } from '../src/daemon.js';
import { initAgentosDir, safeRmSync } from './helpers.js';

function tmpDir(prefix = 'agentos-p7-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Helper to access the private better-sqlite3 db inside EventStore for seeding.
function rawDb(store: EventStore): DB {
  return (store as unknown as { db: DB }).db;
}

// ─── P1-6: ConfidenceCalibrator wired into suggestion generation ───

describe('P1-6 — ConfidenceCalibrator 闭环', () => {
  it('3 次 reject 后, adjust() 的输出低于原始 raw 值', () => {
    const calibrator = new ConfidenceCalibrator();
    calibrator.record('architecture', false);
    calibrator.record('architecture', false);
    calibrator.record('architecture', false);

    const raw = 0.6;
    const adjusted = calibrator.adjust('architecture', raw);
    // acceptRate = 0/3 = 0 → adjusted = 0.6*0.6 + 0*0.4 = 0.36 < 0.6
    expect(adjusted).toBeLessThan(raw);
  });

  it('Daemon 经历 3 次 reject 后新生成建议 confidence < raw', async () => {
    const dir = tmpDir('agentos-p16-');
    initAgentosDir(dir);
    const daemon = new Daemon({ projectDir: dir, port: 0 });
    await daemon.start();

    const se = daemon.getSuggestionEngine();
    const cc = daemon.getConfidenceCalibrator();

    // Simulate 3 rejected suggestions in the 'architecture' category
    cc.record('architecture', false);
    cc.record('architecture', false);
    cc.record('architecture', false);

    // Trigger a large-file event to auto-generate an architecture suggestion
    daemon.appendAndPublish({
      source: 'fs',
      type: 'file_modified',
      payload: { path: `/src/huge-${Date.now()}.ts`, size: 60000 },
      metadata: { project_id: 'default' },
    });

    // Allow the event bus to dispatch
    await new Promise<void>((r) => setTimeout(r, 50));

    const suggestions = se.list().filter((s) => s.category === 'architecture');
    expect(suggestions.length).toBeGreaterThan(0);
    const latest = suggestions[suggestions.length - 1];
    // With 3 rejects: adjusted = 0.6*0.6 + 0.0*0.4 = 0.36 < 0.6
    expect(latest.confidence).toBeLessThan(0.6);

    await daemon.stop();
    safeRmSync(dir);
  });
});

// ─── P1-7: TaskManager replay survives daemon restart ───

describe('P1-7 — TaskManager replay on restart', () => {
  it('daemon 重启后 task 仍在 getTaskManager().list()', async () => {
    const dir = tmpDir('agentos-p17-');
    initAgentosDir(dir);

    // First daemon: create a task
    const d1 = new Daemon({ projectDir: dir, port: 0 });
    await d1.start();
    const task = d1.getTaskManager().create({
      prompt: 'Refactor auth module',
      origin: 'suggestion',
      projectId: 'default',
    });
    expect(task.id).toBeTruthy();
    await d1.stop();

    // Second daemon on the same .agentos dir: task must survive replay
    const d2 = new Daemon({ projectDir: dir, port: 0 });
    await d2.start();
    const restored = d2.getTaskManager().get(task.id);
    expect(restored).toBeDefined();
    expect(restored!.prompt).toBe('Refactor auth module');
    expect(restored!.status).toBe('queued');
    await d2.stop();

    safeRmSync(dir);
  });
});

// ─── P1-8: Deterministic replay ordering (same-ms events) ───

describe('P1-8 — 同毫秒事件按 id ASC 稳定排序', () => {
  let dir: string;
  let store: EventStore;

  beforeAll(async () => {
    dir = tmpDir('agentos-p18-');
    store = new EventStore(path.join(dir, 'events.db'));
    await store.ensureReady();
  });

  afterAll(() => {
    store.close();
    safeRmSync(dir);
  });

  it('3 个相同 timestamp 的事件按 id ASC 返回', () => {
    const sharedTs = new Date().toISOString();
    const db = rawDb(store);
    const insert = db.prepare(
      `INSERT INTO events (id, timestamp, source, type, payload, project_id, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    // Generate three ULIDs and insert them in reverse order (Z → A) so we can
    // confirm query returns them in ascending (A → Z) order.
    const ids = [ulid(), ulid(), ulid()].sort().reverse();
    for (const id of ids) {
      insert.run(id, sharedTs, 'test', 'same_ms_event', '{}', 'test', null);
    }

    const results = store.query({ type: 'same_ms_event' });
    expect(results.length).toBe(3);
    const resultIds = results.map((e) => e.id);
    const sortedAsc = [...resultIds].sort();
    expect(resultIds).toEqual(sortedAsc);
  });
});

// ─── P1-10: snapshot.modules populated ───

describe('P1-10 — snapshot.modules 有内容', () => {
  it('有 package.json 工作区的项目 rebuild 后 modules 非空', async () => {
    const dir = tmpDir('agentos-p110-');
    const agentosDir = initAgentosDir(dir);

    // Create a minimal monorepo structure
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );
    const pkgA = path.join(dir, 'packages', 'alpha');
    fs.mkdirSync(pkgA, { recursive: true });
    fs.writeFileSync(
      path.join(pkgA, 'package.json'),
      JSON.stringify({ name: '@proj/alpha', dependencies: {} }),
    );

    const store = new EventStore(path.join(agentosDir, 'events.db'));
    const bus = new EventBus();
    const engine = new SnapshotEngine('test', store, bus, dir);
    await engine.rebuild();

    const snap = engine.getSnapshot();
    expect(snap.modules.length).toBeGreaterThan(0);
    expect(snap.modules.some((m) => m.name === '@proj/alpha')).toBe(true);

    store.close();
    safeRmSync(dir);
  });

  it('detectModules 失败时 rebuild 不抛异常', async () => {
    const dir = tmpDir('agentos-p110b-');
    const agentosDir = initAgentosDir(dir);
    const store = new EventStore(path.join(agentosDir, 'events.db'));
    const bus = new EventBus();
    // Pass a non-existent projectDir so detectModules gets an empty/missing dir.
    const engine = new SnapshotEngine('test', store, bus, path.join(dir, 'nonexistent'));
    await expect(engine.rebuild()).resolves.toBeUndefined();
    store.close();
    safeRmSync(dir);
  });
});

// ─── P1-11: events_last_hour decays ───

describe('P1-11 — events_last_hour 衰减', () => {
  it('超过 1h 的事件不计入 events_last_hour，新事件计入', async () => {
    const dir = tmpDir('agentos-p111-');
    const agentosDir = initAgentosDir(dir);
    const store = new EventStore(path.join(agentosDir, 'events.db'));
    await store.ensureReady();

    // Insert a stale event (2 hours ago) via raw SQL
    const staleTs = new Date(Date.now() - 2 * 3_600_000).toISOString();
    rawDb(store)
      .prepare(
        `INSERT INTO events (id, timestamp, source, type, payload, project_id, correlation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('stale-event-id', staleTs, 'test', 'stale_event', '{}', 'test', null);

    // Insert a fresh event (just now) normally
    store.append({
      source: 'test',
      type: 'fresh_event',
      payload: {},
      metadata: { project_id: 'test' },
    });

    const bus = new EventBus();
    const engine = new SnapshotEngine('test', store, bus, dir);
    await engine.rebuild();

    const snap = engine.getSnapshot();
    // total_events counts both; events_last_hour counts only the fresh one
    expect(snap.metrics.total_events).toBe(2);
    expect(snap.metrics.events_last_hour).toBe(1);

    store.close();
    safeRmSync(dir);
  });
});

// ─── P2-4: file_event_counts soft cap ───

describe('P2-4 — file_event_counts 软上限 2000', () => {
  it('超过 2000 个不同文件时不再添加新 key', async () => {
    const dir = tmpDir('agentos-p24-');
    const agentosDir = initAgentosDir(dir);
    const store = new EventStore(path.join(agentosDir, 'events.db'));
    await store.ensureReady();

    const bus = new EventBus();
    const engine = new SnapshotEngine('test', store, bus, dir);
    await engine.rebuild();
    engine.start();

    // Flood with 2001 unique file paths via live bus
    for (let i = 0; i < 2001; i++) {
      bus.publish({
        id: `ev-${i}`,
        timestamp: new Date().toISOString(),
        version: 1,
        source: 'fs',
        type: 'file_modified',
        payload: { path: `/src/file-${i}.ts` },
        metadata: { project_id: 'test' },
      });
    }

    engine.stop();
    const snap = engine.getSnapshot();
    // Cap is 2000; the 2001st unique key must be rejected
    expect(Object.keys(snap.file_event_counts).length).toBe(2000);
    expect(snap.metrics.active_files).toBe(2000);

    store.close();
    safeRmSync(dir);
  });

  it('已存在的 key 在达到上限后仍然累加', async () => {
    const dir = tmpDir('agentos-p24b-');
    const agentosDir = initAgentosDir(dir);
    const store = new EventStore(path.join(agentosDir, 'events.db'));
    await store.ensureReady();

    const bus = new EventBus();
    const engine = new SnapshotEngine('test', store, bus, dir);
    await engine.rebuild();
    engine.start();

    // Fill to cap using 2000 unique paths
    for (let i = 0; i < 2000; i++) {
      bus.publish({
        id: `fill-${i}`,
        timestamp: new Date().toISOString(),
        version: 1,
        source: 'fs',
        type: 'file_modified',
        payload: { path: `/src/file-${i}.ts` },
        metadata: { project_id: 'test' },
      });
    }

    // Now modify an already-tracked file 3 more times — count must increment
    for (let j = 0; j < 3; j++) {
      bus.publish({
        id: `reuse-${j}`,
        timestamp: new Date().toISOString(),
        version: 1,
        source: 'fs',
        type: 'file_modified',
        payload: { path: '/src/file-0.ts' },
        metadata: { project_id: 'test' },
      });
    }

    engine.stop();
    const snap = engine.getSnapshot();
    expect(snap.file_event_counts['/src/file-0.ts']).toBe(4); // 1 initial + 3 extra
    expect(Object.keys(snap.file_event_counts).length).toBe(2000); // cap unchanged

    store.close();
    safeRmSync(dir);
  });
});
