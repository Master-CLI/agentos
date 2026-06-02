import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from 'ulid';
import { EventStore } from '../src/events/event-store.js';
import { InitiativeManager } from '../src/initiatives/manager.js';
import { RetrospectiveEngine } from '../src/retrospectives/engine.js';
import { SuggestionEngine } from '../src/suggestions/suggestion-engine.js';
import { Daemon } from '../src/daemon.js';
import type { ProjectEvent, EmitEventFn } from '../src/events/types.js';
import { initAgentosDir, safeRmSync } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p6-'));
}

function makeRecorder(): { events: ProjectEvent[]; emit: EmitEventFn } {
  const events: ProjectEvent[] = [];
  const emit: EmitEventFn = (event) => {
    // Production's EventStore.append JSON-stringifies the payload at write
    // time, so downstream subscribers can't see later in-memory mutations.
    // Mirror that freeze here so replay from the recorded stream matches.
    const frozenPayload = JSON.parse(JSON.stringify(event.payload)) as Record<string, unknown>;
    const full: ProjectEvent = {
      ...event,
      payload: frozenPayload,
      id: ulid(),
      timestamp: new Date().toISOString(),
      version: 1,
    };
    events.push(full);
    return full;
  };
  return { events, emit };
}

// ─── Initiative CRUD ───

describe('Phase 6 — InitiativeManager', () => {
  it('create → get → list 返回同一条 Initiative', () => {
    const im = new InitiativeManager();
    const i = im.create({
      title: '重写 auth 中间件',
      motivation: '合规要求 session 存储方式变更',
      completion_criteria: 'legal 验证 + 所有测试通过',
    });
    expect(i.id).toBeTruthy();
    expect(i.status).toBe('active');
    expect(im.get(i.id)?.title).toBe('重写 auth 中间件');
    expect(im.list().length).toBe(1);
  });

  it('update 能改 title / motivation / owner / deadline', () => {
    const im = new InitiativeManager();
    const i = im.create({ title: 't', motivation: 'm', completion_criteria: 'c' });
    const updated = im.update(i.id, { title: 't2', owner: 'alice', deadline: '2026-06-01' });
    expect(updated.title).toBe('t2');
    expect(updated.owner).toBe('alice');
    expect(updated.deadline).toBe('2026-06-01');
  });

  it('addNote 追加 note,complete / abandon 切换状态', () => {
    const im = new InitiativeManager();
    const i = im.create({ title: 't', motivation: 'm', completion_criteria: 'c' });
    im.addNote(i.id, 'stage 1 done', 'progress');
    im.addNote(i.id, 'blocked by api key', 'blocker');
    expect(im.get(i.id)!.notes.length).toBe(2);
    im.complete(i.id);
    expect(im.get(i.id)!.status).toBe('completed');
    expect(im.get(i.id)!.completed_at).toBeTruthy();
  });

  it('replay 能从事件流恢复状态', () => {
    const recorder = makeRecorder();
    const im1 = new InitiativeManager({ emit: recorder.emit });
    const a = im1.create({ title: 'A', motivation: 'm', completion_criteria: 'c' });
    im1.addNote(a.id, 'n1');
    im1.update(a.id, { owner: 'bob' });
    const b = im1.create({ title: 'B', motivation: 'm', completion_criteria: 'c' });
    im1.abandon(b.id, 'de-prioritized');

    const im2 = new InitiativeManager();
    im2.replay(recorder.events);

    expect(im2.list().length).toBe(2);
    const restoredA = im2.get(a.id)!;
    expect(restoredA.title).toBe('A');
    expect(restoredA.owner).toBe('bob');
    expect(restoredA.notes.length).toBe(1);
    const restoredB = im2.get(b.id)!;
    expect(restoredB.status).toBe('abandoned');
    expect(restoredB.abandoned_at).toBeTruthy();
  });
});

// ─── Suggestion 挂载 Initiative ───

describe('Phase 6 — Suggestion with initiative_id', () => {
  it('create 接受 initiative_id 并通过 replay 保留', () => {
    const recorder = makeRecorder();
    const se1 = new SuggestionEngine({ emit: recorder.emit });
    const s = se1.create({
      category: 'architecture',
      summary: 's',
      detail: 'd',
      evidence: [],
      confidence: 0.7,
      impact: 'medium',
      initiative_id: 'INIT-123',
    });
    expect(s.initiative_id).toBe('INIT-123');

    const se2 = new SuggestionEngine();
    se2.replay(recorder.events);
    expect(se2.get(s.id)?.initiative_id).toBe('INIT-123');
  });
});

// ─── RetrospectiveEngine 聚合 ───

describe('Phase 6 — RetrospectiveEngine.generate', () => {
  let dir: string;
  let store: EventStore;

  beforeAll(async () => {
    dir = tmpDir();
    store = new EventStore(path.join(dir, 'events.db'));
    await store.ensureReady();

    // Seed synthetic events
    store.append({
      source: 'suggestion-engine',
      type: 'suggestion_created',
      payload: { suggestion: { category: 'ci_failure' } },
      metadata: { project_id: 'default' },
    });
    store.append({
      source: 'suggestion-engine',
      type: 'suggestion_created',
      payload: { suggestion: { category: 'ci_failure' } },
      metadata: { project_id: 'default' },
    });
    store.append({
      source: 'suggestion-engine',
      type: 'suggestion_created',
      payload: { suggestion: { category: 'architecture' } },
      metadata: { project_id: 'default' },
    });
    store.append({
      source: 'suggestion-engine',
      type: 'suggestion_status_changed',
      payload: { status: 'rejected' },
      metadata: { project_id: 'default' },
    });
    store.append({
      source: 'suggestion-engine',
      type: 'suggestion_status_changed',
      payload: { status: 'accepted' },
      metadata: { project_id: 'default' },
    });
    store.append({
      source: 'fs',
      type: 'file_modified',
      payload: { path: 'src/auth.ts' },
      metadata: { project_id: 'default' },
    });
    store.append({
      source: 'fs',
      type: 'file_modified',
      payload: { path: 'src/auth.ts' },
      metadata: { project_id: 'default' },
    });
    store.append({
      source: 'git',
      type: 'commit_pushed',
      payload: { hash: 'abc123', message: 'x' },
      metadata: { project_id: 'default' },
    });
  });

  afterAll(() => {
    store.close();
    safeRmSync(dir);
  });

  it('聚合 suggestions / tasks / commits 数量', () => {
    const engine = new RetrospectiveEngine({ eventStore: store });
    const report = engine.generate({ windowMs: 24 * 60 * 60 * 1000 });
    expect(report.suggestions.created).toBe(3);
    expect(report.suggestions.rejected).toBe(1);
    expect(report.suggestions.accepted).toBe(1);
    expect(report.suggestions.by_category.ci_failure).toBe(2);
    expect(report.suggestions.by_category.architecture).toBe(1);
    expect(report.commit_count).toBe(1);
    expect(report.top_regions[0].path).toBe('src/auth.ts');
    expect(report.top_regions[0].count).toBe(2);
  });

  it('标注 stale Initiative', () => {
    const im = new InitiativeManager();
    const fresh = im.create({ title: 'fresh', motivation: 'm', completion_criteria: 'c' });
    // Stale: created 30 days ago, no notes
    const stale = im.create({ title: 'stale', motivation: 'm', completion_criteria: 'c' });
    const staleCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    (im.get(stale.id) as { created_at: string }).created_at = staleCreatedAt;

    const engine = new RetrospectiveEngine({ eventStore: store, initiativeManager: im, staleDays: 14 });
    const report = engine.generate({ windowMs: 24 * 60 * 60 * 1000 });
    expect(report.initiatives.active).toBe(2);
    expect(report.initiatives.stale.length).toBe(1);
    expect(report.initiatives.stale[0].title).toBe('stale');
    void fresh;
  });

  it('replay 能从 retrospective_generated 事件恢复报告列表', () => {
    const recorder = makeRecorder();
    const e1 = new RetrospectiveEngine({ eventStore: store, emit: recorder.emit });
    const r1 = e1.generate({ windowMs: 60000 });
    const r2 = e1.generate({ windowMs: 60000 });

    const e2 = new RetrospectiveEngine({ eventStore: store });
    e2.replay(recorder.events);
    expect(e2.list().length).toBe(2);
    expect(e2.get(r1.id)?.id).toBe(r1.id);
    expect(e2.get(r2.id)?.id).toBe(r2.id);
  });
});

// ─── Daemon 集成:API + 挂载 ───

describe('Phase 6 — Daemon Initiative + Retrospective API', () => {
  let daemon: Daemon;
  let projectDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = tmpDir();
    initAgentosDir(projectDir);
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;
  });

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  it('POST /api/initiatives → 创建 + GET 列表返回', async () => {
    const res = await fetch(`${baseUrl}/api/initiatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'AgentOS 并行协议',
        motivation: '统一主/子 agent 分工',
        completion_criteria: 'docs + init 模板落地',
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; title: string };
    expect(created.id).toBeTruthy();

    const listRes = await fetch(`${baseUrl}/api/initiatives`);
    const list = await listRes.json() as Array<{ id: string }>;
    expect(list.some((i) => i.id === created.id)).toBe(true);
  });

  it('POST /api/retrospectives/generate → 产出 report 事件落盘', async () => {
    const res = await fetch(`${baseUrl}/api/retrospectives/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowMs: 3600_000 }),
    });
    expect(res.status).toBe(201);
    const report = await res.json() as { id: string; suggestions: { created: number } };
    expect(report.id).toBeTruthy();
    expect(typeof report.suggestions.created).toBe('number');

    // Should come back in listing
    const listRes = await fetch(`${baseUrl}/api/retrospectives`);
    const list = await listRes.json() as Array<{ id: string }>;
    expect(list.some((r) => r.id === report.id)).toBe(true);
  });
});
