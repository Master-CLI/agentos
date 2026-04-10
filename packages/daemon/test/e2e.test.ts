import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { Daemon } from '../src/daemon.js';
import { safeRmSync } from './helpers.js';
import WebSocket from 'ws';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-e2e-'));
}

describe('E2E — 完整 init → start → 使用 → stop 链路', () => {
  let projectDir: string;
  let daemon: Daemon;
  let baseUrl: string;

  beforeAll(async () => {
    // Create a realistic project structure
    projectDir = tmpDir();
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({
      name: 'my-test-project',
      dependencies: { express: '5.0.0' },
      devDependencies: { vitest: '2.0.0', typescript: '5.5.0' },
    }));
    fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'src', 'index.ts'), 'export const app = "hello";');

    // Run init via CLI module
    const { initProject } = await import('../../cli/src/commands/init.js');
    await initProject(projectDir);

    // Start daemon programmatically (like `agentos start`)
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;
  }, 30000);

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  // ── Init 验证 ──

  it('.agentos/ 目录已创建', () => {
    expect(fs.existsSync(path.join(projectDir, '.agentos'))).toBe(true);
  });

  it('config.json 包含 providers 和 ollama 字段', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.agentos', 'config.json'), 'utf-8')
    );
    expect(config.providers).toBeTruthy();
    expect(config.ollama).toBeTruthy();
  });

  it('init-report.json 包含项目结构信息', () => {
    const report = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.agentos', 'init-report.json'), 'utf-8')
    );
    expect(report.structure.package_name).toBe('my-test-project');
    expect(report.dependencies).toBe(3); // express + vitest + typescript
  });

  // ── Health 验证 ──

  it('GET /health → 200 ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe('ok');
  });

  // ── WebSocket 验证 ──

  it('WebSocket 可连接并收到握手', async () => {
    const msg = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${daemon.port}`);
      ws.on('message', (data) => { ws.close(); resolve(JSON.parse(data.toString())); });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    });
    expect(msg.type).toBe('connected');
  });

  // ── Dialog → Task 链路 ──

  let taskId: string;

  it('POST /api/dialog → 创建任务', async () => {
    const res = await fetch(`${baseUrl}/api/dialog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '给 src/index.ts 添加一个 greet 函数' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.task_id).toBeTruthy();
    taskId = body.task_id;
  });

  it('GET /api/tasks → 包含刚创建的任务', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const tasks = await res.json() as any[];
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const found = tasks.find((t: any) => t.id === taskId);
    expect(found).toBeTruthy();
    expect(found.origin).toBe('user');
  });

  it('GET /api/tasks/:id → 返回完整任务详情', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`);
    expect(res.status).toBe(200);
    const task = await res.json() as any;
    expect(task.id).toBe(taskId);
    expect(task.pipeline).toBeTruthy();
    expect(task.prompt).toContain('greet');
  });

  it('POST /api/tasks/:id/accept → 任务完成', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/accept`, { method: 'POST' });
    expect(res.status).toBe(200);
    const task = await res.json() as any;
    expect(task.status).toBe('completed');
  });

  // ── 建议链路 ──

  it('建议创建 + GET /api/suggestions', async () => {
    // Create a suggestion through the engine
    const se = daemon.getSuggestionEngine();
    se.create({
      category: 'dependency_drift',
      summary: 'express 5.0.0 has known vulnerability',
      detail: 'CVE-2025-XXXX',
      evidence: ['npm audit output'],
      confidence: 0.9,
      impact: 'high',
    });

    const res = await fetch(`${baseUrl}/api/suggestions`);
    expect(res.status).toBe(200);
    const suggestions = await res.json() as any[];
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
  });

  // ── Telemetry 验证 ──

  it('GET /api/telemetry/metrics → 有任务统计', async () => {
    const res = await fetch(`${baseUrl}/api/telemetry/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tasks_total).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/telemetry/traces?task_id → 返回 trace', async () => {
    const res = await fetch(`${baseUrl}/api/telemetry/traces?task_id=${taskId}`);
    expect(res.status).toBe(200);
    const trace = await res.json() as any;
    expect(trace.task_id).toBe(taskId);
    expect(trace.status).toBe('completed');
  });

  // ── 审计日志 ──

  it('GET /api/audit → 有系统启动和任务记录', async () => {
    const res = await fetch(`${baseUrl}/api/audit`);
    expect(res.status).toBe(200);
    const entries = await res.json() as any[];
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const actions = entries.map((e: any) => e.action);
    expect(actions).toContain('daemon_started');
  });

  // ── 设置 ──

  it('PUT /api/settings → 更新 config', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_execute: false }),
    });
    expect(res.status).toBe(200);
    const config = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.agentos', 'config.json'), 'utf-8')
    );
    expect(config.auto_execute).toBe(false);
  });
});
