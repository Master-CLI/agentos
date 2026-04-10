import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Daemon } from '../src/daemon.js';
import { TaskManager } from '../src/pipeline/task-manager.js';
import { MetricsCollector } from '../src/telemetry/metrics-collector.js';
import { AuditLog } from '../src/telemetry/audit-log.js';
import { SuggestionEngine } from '../src/suggestions/suggestion-engine.js';
import { safeRmSync } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p5-'));
}
function initAgentosDir(dir: string): string {
  const d = path.join(dir, '.agentos');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ version: '0.1.0', providers: [], port: 0 }));
  return d;
}

// ─── 自观测 ───

describe('Phase 5 — 自观测', () => {
  let daemon: Daemon;
  let projectDir: string;
  let baseUrl: string;
  let tm: TaskManager;
  let mc: MetricsCollector;

  beforeAll(async () => {
    projectDir = tmpDir();
    const agentosDir = initAgentosDir(projectDir);
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;

    tm = new TaskManager();
    mc = new MetricsCollector();
    (daemon as any).apiServer.setTaskManager(tm);
    (daemon as any).apiServer.setMetricsCollector(mc);

    // Create some tasks for metrics
    const t1 = tm.create({ prompt: 'task 1', origin: 'user', projectId: 'test' });
    tm.create({ prompt: 'task 2', origin: 'system', projectId: 'test' });
    mc.recordPipelineLatency(1500);
    mc.recordPipelineLatency(2500);
    mc.recordProviderCall('claude-code');
    mc.recordProviderCall('claude-code');
    mc.recordProviderCall('codex');
  });

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  it('GET /api/telemetry/metrics → 返回 tasks_total, avg_latency, provider_usage', async () => {
    const res = await fetch(`${baseUrl}/api/telemetry/metrics`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.tasks_total).toBe(2);
    expect(body.avg_pipeline_latency_ms).toBe(2000);
    expect(body.provider_usage['claude-code']).toBe(2);
    expect(body.provider_usage['codex']).toBe(1);
  });

  it('GET /api/telemetry/traces?task_id=X → 返回完整 trace', async () => {
    const tasks = tm.list();
    const id = tasks[0].id;
    const res = await fetch(`${baseUrl}/api/telemetry/traces?task_id=${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.task_id).toBe(id);
    expect(body.prompt).toBeTruthy();
    expect(body.pipeline).toBeTruthy();
    expect(body.pipeline.consensus).toBeTruthy();
  });
});

// ─── 设置 ───

describe('Phase 5 — 设置', () => {
  let daemon: Daemon;
  let projectDir: string;
  let baseUrl: string;
  let configPath: string;

  beforeAll(async () => {
    projectDir = tmpDir();
    const agentosDir = initAgentosDir(projectDir);
    configPath = path.join(agentosDir, 'config.json');
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;
    (daemon as any).apiServer.setConfigPath(configPath);
  });

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  it('PUT /api/settings { watch_paths: [...] } → config.json 更新', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watch_paths: ['src/', 'lib/'] }),
    });
    expect(res.status).toBe(200);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.watch_paths).toEqual(['src/', 'lib/']);
  });

  it('PUT /api/settings { auto_execute: false } → config.json 反映', async () => {
    const res = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_execute: false }),
    });
    expect(res.status).toBe(200);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.auto_execute).toBe(false);
    // Previous settings preserved
    expect(config.watch_paths).toEqual(['src/', 'lib/']);
  });
});

// ─── 审计日志 ───

describe('Phase 5 — 审计日志', () => {
  let daemon: Daemon;
  let projectDir: string;
  let baseUrl: string;
  let al: AuditLog;

  beforeAll(async () => {
    projectDir = tmpDir();
    initAgentosDir(projectDir);
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;

    al = new AuditLog();
    (daemon as any).apiServer.setAuditLog(al);

    al.record({ actor: 'user', action: 'task_accepted', target: 'TASK-001', detail: 'approved all changes' });
    al.record({ actor: 'system', action: 'suggestion_created', target: 'SUG-001' });
    al.record({ actor: 'user', action: 'task_discarded', target: 'TASK-002' });
  });

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  it('GET /api/audit → 返回所有操作记录', async () => {
    const res = await fetch(`${baseUrl}/api/audit`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(body.length).toBe(3);
  });

  it('每条记录包含 timestamp, actor, action, target', async () => {
    const res = await fetch(`${baseUrl}/api/audit`);
    const body = await res.json() as any[];
    const entry = body[0];
    expect(entry.timestamp).toBeTruthy();
    expect(entry.actor).toBeTruthy();
    expect(entry.action).toBeTruthy();
    expect(entry.target).toBeTruthy();
  });
});

// ─── 多项目 ───

describe('Phase 5 — 多项目', () => {
  it('两个不同目录 init → 各自有独立 .agentos', async () => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();

    const { initProject } = await import('../../cli/src/commands/init.js');
    await initProject(dir1);
    await initProject(dir2);

    expect(fs.existsSync(path.join(dir1, '.agentos', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir2, '.agentos', 'config.json'))).toBe(true);

    // Events DB are independent (write to dir1, dir2 shouldn't see it)
    const { EventStore } = await import('../src/events/event-store.js');
    const store1 = new EventStore(path.join(dir1, '.agentos', 'events.db'));
    const store2 = new EventStore(path.join(dir2, '.agentos', 'events.db'));
    await store1.ensureReady();
    await store2.ensureReady();

    store1.append({ source: 'test', type: 'x', payload: {}, metadata: { project_id: 'p1' } });
    expect(store1.count()).toBe(1);
    expect(store2.count()).toBe(0);

    store1.close();
    store2.close();
    safeRmSync(dir1);
    safeRmSync(dir2);
  });
});
