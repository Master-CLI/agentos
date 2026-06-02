import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Daemon } from '../src/daemon.js';
import { safeRmSync } from './helpers.js';
import WebSocket from 'ws';
import type { ReasoningProvider, ReasoningTask, ReasoningResult } from '../src/reasoning/types.js';

/**
 * Hermetic stub: satisfies ReasoningProvider without spawning any real process.
 * Registered for the 'local-llm' provider name so it is picked up by the
 * 'interpret' task type (ROUTING_TABLE maps interpret → local-llm).
 */
class StubReasoningProvider implements ReasoningProvider {
  readonly name = 'local-llm' as const;
  readonly available = true;

  invoke(task: ReasoningTask): Promise<ReasoningResult> {
    return Promise.resolve({
      task_id: task.id,
      provider: this.name,
      output: 'This is a TypeScript project.',
      confidence: 1,
      latency_ms: 0,
    });
  }
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-e2e-'));
}

describe('E2E — init → start → chat → suggestions → stop', () => {
  let projectDir: string;
  let daemon: Daemon;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = tmpDir();
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'my-test-project',
      dependencies: { express: '5.0.0' },
      devDependencies: { vitest: '2.0.0', typescript: '5.5.0' },
    }));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const app = "hello";');

    const { initProject } = await import('../../cli/src/commands/init.js');
    await initProject(projectDir);

    daemon = new Daemon({ projectDir, port: 0, reasoningProviders: [new StubReasoningProvider()] });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;
  }, 60000);

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  // ── Init ──

  it('.agentos/ 目录已创建', () => {
    expect(fs.existsSync(path.join(projectDir, '.agentos'))).toBe(true);
  });

  it('init-report.json 正确', () => {
    const report = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.agentos', 'init-report.json'), 'utf-8')
    );
    expect(report.structure.package_name).toBe('my-test-project');
    expect(report.dependencies).toBe(3);
  });

  // ── Health ──

  it('GET /health → 200', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  // ── WebSocket ──

  it('WebSocket 握手', async () => {
    const msg = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${daemon.port}`);
      ws.on('message', (data) => { ws.close(); resolve(JSON.parse(data.toString())); });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    });
    expect(msg.type).toBe('connected');
  });

  // ── Dialog (项目问答) ──

  it('POST /api/dialog → 返回 assistant 消息', async () => {
    const res = await fetch(`${baseUrl}/api/dialog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'What is this project?' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.role).toBe('assistant');
    expect(body.content).toBeTruthy();
  });

  it('GET /api/dialog/history → 有对话记录', async () => {
    const res = await fetch(`${baseUrl}/api/dialog/history`);
    expect(res.status).toBe(200);
    const history = await res.json() as any[];
    expect(history.length).toBeGreaterThanOrEqual(2); // user + assistant
  });

  it('GET /api/dialog/context → 有项目上下文', async () => {
    const res = await fetch(`${baseUrl}/api/dialog/context`);
    expect(res.status).toBe(200);
    const ctx = await res.json() as any;
    expect(ctx.snapshot).toBeTruthy();
    expect(ctx.snapshot.metrics).toBeTruthy();
  });

  // ── Suggestions ──

  it('GET /api/suggestions → 数组', async () => {
    // Manually create a suggestion
    daemon.getSuggestionEngine().create({
      category: 'dependency_drift',
      summary: 'express 5.0.0 vulnerability',
      detail: 'CVE-2025-XXXX',
      evidence: ['npm audit'],
      confidence: 0.9,
      impact: 'high',
    });

    const res = await fetch(`${baseUrl}/api/suggestions`);
    expect(res.status).toBe(200);
    const suggestions = await res.json() as any[];
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/suggestions/:id/dismiss → 状态变 rejected', async () => {
    // Create a fresh suggestion so this test is self-contained and deterministic.
    const created = daemon.getSuggestionEngine().create({
      category: 'architecture',
      summary: 'dismiss test suggestion',
      detail: 'created by dismiss test',
      evidence: ['test'],
      confidence: 0.8,
      impact: 'low',
    });

    const res = await fetch(`${baseUrl}/api/suggestions/${created.id}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('rejected');
  });

  // ── Telemetry ──

  it('GET /api/telemetry/metrics → 有 dialog_count', async () => {
    const res = await fetch(`${baseUrl}/api/telemetry/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(typeof body.dialog_count).toBe('number');
    expect(typeof body.suggestions_total).toBe('number');
  });

  // ── Audit ──

  it('GET /api/audit → 有 daemon_started 记录', async () => {
    const res = await fetch(`${baseUrl}/api/audit`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any[];
    expect(entries.some((e: any) => e.action === 'daemon_started')).toBe(true);
  });

  // ── Settings ──

  it('PUT /api/settings → 更新 config', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_execute: false }),
    });
    expect(res.status).toBe(200);
  });
});
