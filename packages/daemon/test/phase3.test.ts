import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DialogHandler } from '../src/dialog/dialog-handler.js';
import { SuggestionEngine } from '../src/suggestions/suggestion-engine.js';
import { ReasoningRouter } from '../src/reasoning/router.js';
import { EventStore } from '../src/events/event-store.js';
import { EventBus } from '../src/events/event-bus.js';
import { SnapshotEngine } from '../src/state/snapshot-engine.js';
import type { ReasoningProvider, ReasoningResult, ReasoningTask } from '../src/reasoning/types.js';
import { safeRmSync } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p3-'));
}

// ─── DialogHandler: ask() ───

describe('Phase 3 — DialogHandler ask()', () => {
  let dir: string;
  let handler: DialogHandler;

  beforeAll(async () => {
    dir = tmpDir();

    const eventStore = new EventStore(path.join(dir, 'events.db'));
    await eventStore.ensureReady();

    const eventBus = new EventBus();
    const snapshotEngine = new SnapshotEngine('test', eventStore, eventBus);
    await snapshotEngine.rebuild();
    snapshotEngine.start();

    const suggestionEngine = new SuggestionEngine();

    // Register a mock provider that returns "mock response"
    const router = new ReasoningRouter();
    const mockProvider: ReasoningProvider = {
      name: 'local-llm',
      available: true,
      invoke: async (task: ReasoningTask): Promise<ReasoningResult> => ({
        task_id: task.id,
        provider: 'local-llm',
        output: 'mock response',
        confidence: 0.9,
        latency_ms: 50,
      }),
    };
    router.registerProvider(mockProvider);

    handler = new DialogHandler(router, snapshotEngine, eventStore, suggestionEngine);
  });

  afterAll(() => {
    safeRmSync(dir);
  });

  it('ask() 返回 assistant 消息，包含项目上下文', async () => {
    const msg = await handler.ask('项目状态如何？');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('mock response');
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeTruthy();
  });
});

// ─── DialogHandler: history ───

describe('Phase 3 — DialogHandler history', () => {
  let dir: string;
  let handler: DialogHandler;

  beforeAll(async () => {
    dir = tmpDir();

    const eventStore = new EventStore(path.join(dir, 'events.db'));
    await eventStore.ensureReady();

    const eventBus = new EventBus();
    const snapshotEngine = new SnapshotEngine('test', eventStore, eventBus);
    await snapshotEngine.rebuild();
    snapshotEngine.start();

    const suggestionEngine = new SuggestionEngine();

    const router = new ReasoningRouter();
    const mockProvider: ReasoningProvider = {
      name: 'local-llm',
      available: true,
      invoke: async (task: ReasoningTask): Promise<ReasoningResult> => ({
        task_id: task.id,
        provider: 'local-llm',
        output: 'mock response',
        confidence: 0.9,
        latency_ms: 50,
      }),
    };
    router.registerProvider(mockProvider);

    handler = new DialogHandler(router, snapshotEngine, eventStore, suggestionEngine);
  });

  afterAll(() => {
    safeRmSync(dir);
  });

  it('history 正确累积 user 和 assistant 消息', async () => {
    expect(handler.getHistory().length).toBe(0);

    await handler.ask('第一个问题');
    expect(handler.getHistory().length).toBe(2); // user + assistant

    await handler.ask('第二个问题');
    const history = handler.getHistory();
    expect(history.length).toBe(4); // 2 pairs
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('第一个问题');
    expect(history[1].role).toBe('assistant');
    expect(history[2].role).toBe('user');
    expect(history[2].content).toBe('第二个问题');
    expect(history[3].role).toBe('assistant');
  });
});

// ─── DialogHandler: buildContext ───

describe('Phase 3 — DialogHandler buildContext', () => {
  let dir: string;
  let handler: DialogHandler;

  beforeAll(async () => {
    dir = tmpDir();

    const eventStore = new EventStore(path.join(dir, 'events.db'));
    await eventStore.ensureReady();

    // Append some events so the context is non-empty
    eventStore.append({
      source: 'fs',
      type: 'file_modified',
      payload: { path: 'src/index.ts' },
      metadata: { project_id: 'test' },
    });

    const eventBus = new EventBus();
    const snapshotEngine = new SnapshotEngine('test', eventStore, eventBus);
    await snapshotEngine.rebuild();
    snapshotEngine.start();

    const suggestionEngine = new SuggestionEngine();
    suggestionEngine.create({
      category: 'general',
      summary: 'test suggestion',
      detail: 'detail',
      evidence: [],
      confidence: 0.5,
      impact: 'low',
    });

    const router = new ReasoningRouter();
    const mockProvider: ReasoningProvider = {
      name: 'local-llm',
      available: true,
      invoke: async (task: ReasoningTask): Promise<ReasoningResult> => ({
        task_id: task.id,
        provider: 'local-llm',
        output: 'mock response',
        confidence: 0.9,
        latency_ms: 50,
      }),
    };
    router.registerProvider(mockProvider);

    handler = new DialogHandler(router, snapshotEngine, eventStore, suggestionEngine);
  });

  afterAll(() => {
    safeRmSync(dir);
  });

  it('getContext() 返回 snapshot 和 recentEvents', () => {
    const ctx = handler.getContext();
    expect(ctx.snapshot).toBeTruthy();
    expect(ctx.snapshot.metrics).toBeTruthy();
    expect(ctx.snapshot.metrics.total_events).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(ctx.recentEvents)).toBe(true);
    expect(ctx.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(ctx.recentEvents[0].type).toBe('file_modified');
    expect(ctx.pendingSuggestions).toBe(1);
  });
});

// ─── Suggestion dismiss/acknowledge ───

describe('Phase 3 — Suggestion 状态转换', () => {
  it('dismiss → status 变为 rejected', () => {
    const se = new SuggestionEngine();
    const s = se.create({
      category: 'ci_failure',
      summary: 'test',
      detail: 'detail',
      evidence: [],
      confidence: 0.8,
      impact: 'medium',
    });
    expect(s.status).toBe('pending');

    const dismissed = se.dismiss(s.id);
    expect(dismissed.status).toBe('rejected');
    expect(se.get(s.id)!.status).toBe('rejected');
  });

  it('acknowledge → status 变为 accepted', () => {
    const se = new SuggestionEngine();
    const s = se.create({
      category: 'dependency_drift',
      summary: 'test',
      detail: 'detail',
      evidence: ['e1'],
      confidence: 0.9,
      impact: 'high',
    });
    expect(s.status).toBe('pending');

    const acked = se.acknowledge(s.id);
    expect(acked.status).toBe('accepted');
    expect(se.get(s.id)!.status).toBe('accepted');
  });

  it('不存在的 id → 抛出错误', () => {
    const se = new SuggestionEngine();
    expect(() => se.dismiss('NONEXISTENT')).toThrow();
    expect(() => se.acknowledge('NONEXISTENT')).toThrow();
  });
});
