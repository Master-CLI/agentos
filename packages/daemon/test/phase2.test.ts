import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ReasoningRouter } from '../src/reasoning/router.js';
import { LocalLlmProvider } from '../src/reasoning/local-llm.js';
import { CliAgentProvider, detectCliAgents } from '../src/reasoning/cli-agent.js';
import { SnapshotEngine } from '../src/state/snapshot-engine.js';
import { detectModules } from '../src/state/module-detector.js';
import { EventStore } from '../src/events/event-store.js';
import { EventBus } from '../src/events/event-bus.js';
import type { ReasoningProvider } from '../src/reasoning/types.js';
import { safeRmSync } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p2-'));
}

// ─── 推理调度器 路由 ───

describe('Phase 2 — 推理调度器', () => {
  it('type=classify 路由到 local-llm', () => {
    const router = new ReasoningRouter();
    const mock: ReasoningProvider = { name: 'local-llm', available: true, invoke: async () => ({} as any) };
    router.registerProvider(mock);
    expect(router.route('classify')).toBe('local-llm');
  });

  it('type=summarize 路由到 local-llm', () => {
    const router = new ReasoningRouter();
    const mock: ReasoningProvider = { name: 'local-llm', available: true, invoke: async () => ({} as any) };
    router.registerProvider(mock);
    expect(router.route('summarize')).toBe('local-llm');
  });

  it('type=diagnose 路由到 cli-agent', () => {
    const router = new ReasoningRouter();
    const mock: ReasoningProvider = { name: 'claude-code', available: true, invoke: async () => ({} as any) };
    router.registerProvider(mock);
    expect(router.route('diagnose')).toBe('claude-code');
  });

  it('claude-code 不可用时 diagnose 降级到 codex', () => {
    const router = new ReasoningRouter();
    const claude: ReasoningProvider = { name: 'claude-code', available: false, invoke: async () => ({} as any) };
    const codex: ReasoningProvider = { name: 'codex', available: true, invoke: async () => ({} as any) };
    router.registerProvider(claude);
    router.registerProvider(codex);
    expect(router.route('diagnose')).toBe('codex');
  });

  it('所有 CLI agent 不可用时 diagnose 返回 null', () => {
    const router = new ReasoningRouter();
    const claude: ReasoningProvider = { name: 'claude-code', available: false, invoke: async () => ({} as any) };
    router.registerProvider(claude);
    expect(router.route('diagnose')).toBeNull();
  });

  it('Ollama 不可用时 classify 返回 null（不崩溃）', () => {
    const router = new ReasoningRouter();
    const mock: ReasoningProvider = { name: 'local-llm', available: false, invoke: async () => ({} as any) };
    router.registerProvider(mock);
    expect(router.route('classify')).toBeNull();
  });
});

// ─── 本地 LLM 适配器 ───

describe('Phase 2 — 本地 LLM 适配器', () => {
  let provider: LocalLlmProvider;
  let ollamaAvailable: boolean;

  beforeAll(async () => {
    provider = new LocalLlmProvider();
    ollamaAvailable = await provider.checkAvailability();
  });

  it('checkAvailability 返回布尔值', () => {
    expect(typeof ollamaAvailable).toBe('boolean');
  });

  it('发送测试 prompt → 返回结果包含 output, confidence, latency_ms', { timeout: 60000 }, async () => {
    if (!ollamaAvailable) return; // Skip if Ollama not running

    const result = await provider.invoke({
      id: 'test-1',
      type: 'classify',
      prompt: 'Reply with exactly one word: OK',
      input: {},
      constraints: { max_latency_ms: 60000, min_confidence: 0 },
    });

    expect(result.output).toBeTruthy();
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.latency_ms).toBe('number');
    expect(result.provider).toBe('local-llm');
  });

  it('超时时抛出错误', async () => {
    if (!ollamaAvailable) return;

    const shortTimeout = new LocalLlmProvider({ timeoutMs: 1 }); // 1ms timeout
    await expect(
      shortTimeout.invoke({
        id: 'test-timeout',
        type: 'classify',
        prompt: 'Write a long essay about everything',
        input: {},
        constraints: { max_latency_ms: 1, min_confidence: 0 },
      })
    ).rejects.toThrow();
  });
});

// ─── CLI Agent 适配器 ───

describe('Phase 2 — CLI Agent 适配器', () => {
  it('调用不存在的 provider → 抛出错误', () => {
    expect(() => new CliAgentProvider('nonexistent' as any)).toThrow('Unknown CLI agent provider');
  });

  it('checkAvailability 返回布尔值', async () => {
    const provider = new CliAgentProvider('claude-code');
    const result = await provider.checkAvailability();
    expect(typeof result).toBe('boolean');
  });
});

// ─── Provider 探测 ───

describe('Phase 2 — Provider 探测', () => {
  it('探测结果包含 name 和 available 字段', async () => {
    const providers = await detectCliAgents();
    expect(providers.length).toBe(3); // claude-code, codex, gemini

    for (const p of providers) {
      expect(p.name).toBeTruthy();
      expect(typeof p.available).toBe('boolean');
    }
  });

  it('每个 provider name 为 claude-code / codex / gemini', async () => {
    const providers = await detectCliAgents();
    const names = providers.map((p) => p.name);
    expect(names).toContain('claude-code');
    expect(names).toContain('codex');
    expect(names).toContain('gemini');
  });
});

// ─── 状态快照 ───

describe('Phase 2 — 状态快照', () => {
  let store: EventStore;
  let bus: EventBus;
  let engine: SnapshotEngine;
  let dir: string;

  beforeAll(async () => {
    dir = tmpDir();
    store = new EventStore(path.join(dir, 'events.db'));
    await store.ensureReady();
    bus = new EventBus();
    engine = new SnapshotEngine('test-project', store, bus);
    engine.start();
  });

  afterAll(() => {
    engine.stop();
    store.close();
    safeRmSync(dir);
  });

  it('写入 10 条事件 → 快照 version ≥ 1', () => {
    for (let i = 0; i < 10; i++) {
      const event = store.append({
        source: 'fs',
        type: 'file_modified',
        payload: { path: `/src/file${i}.ts` },
        metadata: { project_id: 'test-project' },
      });
      bus.publish(event);
    }
    const snap = engine.getSnapshot();
    expect(snap.version).toBeGreaterThanOrEqual(10);
  });

  it('快照 last_event_id 等于最后写入的事件 ID', () => {
    const events = store.query({});
    const lastEvent = events[events.length - 1];
    const snap = engine.getSnapshot();
    expect(snap.last_event_id).toBe(lastEvent.id);
  });

  it('从事件重建快照后 version 不回退', async () => {
    const vBefore = engine.getSnapshot().version;

    // Create new engine and rebuild from store
    const engine2 = new SnapshotEngine('test-project', store, bus);
    await engine2.rebuild();
    const snap2 = engine2.getSnapshot();

    expect(snap2.version).toBe(vBefore);
    engine2.stop();
  });

  it('快照 metrics 包含 total_events 和 active_files', () => {
    const snap = engine.getSnapshot();
    expect(snap.metrics.total_events).toBeGreaterThanOrEqual(10);
    expect(snap.metrics.active_files).toBeGreaterThan(0);
  });
});

// ─── 模块识别 ───

describe('Phase 2 — 模块识别', () => {
  it('标准 monorepo 结构 → 识别出 ≥ 2 个模块', () => {
    const dir = tmpDir();
    // Create monorepo structure
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'my-monorepo',
      workspaces: ['packages/*'],
    }));
    fs.mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'core', 'package.json'), JSON.stringify({
      name: '@my/core',
      dependencies: { lodash: '4.0.0' },
    }));
    fs.mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'web', 'package.json'), JSON.stringify({
      name: '@my/web',
      dependencies: { react: '19.0.0', '@my/core': '*' },
    }));

    const modules = detectModules(dir);
    expect(modules.length).toBeGreaterThanOrEqual(2);
    safeRmSync(dir);
  });

  it('每个模块包含 name, path, dependencies', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'my-monorepo',
      workspaces: ['packages/*'],
    }));
    fs.mkdirSync(path.join(dir, 'packages', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'api', 'package.json'), JSON.stringify({
      name: '@my/api',
      dependencies: { express: '5.0.0' },
    }));

    const modules = detectModules(dir);
    const mod = modules.find((m) => m.name === '@my/api');
    expect(mod).toBeTruthy();
    expect(mod!.path).toContain('api');
    expect(mod!.dependencies).toContain('express');
    safeRmSync(dir);
  });
});
