import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../src/events/event-store.js';
import { EventBus } from '../src/events/event-bus.js';
import { Daemon } from '../src/daemon.js';
import WebSocket from 'ws';
import { safeRmSync } from './helpers.js';

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-test-'));
  return dir;
}

function initAgentosDir(projectDir: string): string {
  const agentosDir = path.join(projectDir, '.agentos');
  fs.mkdirSync(agentosDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentosDir, 'config.json'),
    JSON.stringify({ version: '0.1.0', providers: [], port: 0 }),
  );
  return agentosDir;
}

// ─── Monorepo structure ───

describe('Phase 0 — monorepo 结构完整性', () => {
  const root = path.resolve(__dirname, '../../..');

  it('packages/cli/package.json 存在且 name 正确', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/cli/package.json'), 'utf-8'));
    expect(pkg.name).toBe('@agentos/cli');
  });

  it('packages/daemon/package.json 存在且 name 正确', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/daemon/package.json'), 'utf-8'));
    expect(pkg.name).toBe('@agentos/daemon');
  });

  it('packages/web/package.json 存在且 name 正确', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/web/package.json'), 'utf-8'));
    expect(pkg.name).toBe('@agentos/web');
  });
});

// ─── SQLite Event Store ───

describe('Phase 0 — SQLite 事件存储', () => {
  let store: EventStore;
  let dir: string;

  beforeAll(async () => {
    dir = tmpDir();
    store = new EventStore(path.join(dir, 'events.db'));
    await store.ensureReady();
  });

  afterAll(() => {
    store.close();
    safeRmSync(dir);
  });

  it('写入 3 条事件后 events.db 文件大小 > 0', () => {
    for (let i = 0; i < 3; i++) {
      store.append({
        source: 'test',
        type: 'test_event',
        payload: { index: i },
        metadata: { project_id: 'test-project' },
      });
    }
    const dbPath = path.join(dir, 'events.db');
    const stat = fs.statSync(dbPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('按时间范围查询返回正确数量', () => {
    const all = store.query({});
    expect(all.length).toBe(3);
  });

  it('事件字段完整（id, timestamp, source, type, payload）', () => {
    const events = store.query({});
    const event = events[0];
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
    expect(event.source).toBe('test');
    expect(event.type).toBe('test_event');
    expect(event.payload).toHaveProperty('index');
    expect(event.metadata.project_id).toBe('test-project');
  });
});

// ─── Daemon lifecycle ───

describe('Phase 0 — 守护进程生命周期', () => {
  let daemon: Daemon;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = tmpDir();
    initAgentosDir(projectDir);
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  it('启动后 PID 文件可读', () => {
    const pidPath = path.join(projectDir, '.agentos', 'daemon.pid');
    expect(fs.existsSync(pidPath)).toBe(true);
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    expect(pid).toBe(process.pid);
  });

  it('GET /health 返回 200 + { status: "ok" }', async () => {
    const res = await fetch(`http://localhost:${daemon.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

// ─── WebSocket ───

describe('Phase 0 — WebSocket 连通', () => {
  let daemon: Daemon;
  let projectDir: string;

  beforeAll(async () => {
    projectDir = tmpDir();
    initAgentosDir(projectDir);
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
  });

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  it('WebSocket 可连接并收到 connected 握手消息', async () => {
    const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${daemon.port}`);
      ws.on('message', (data) => {
        ws.close();
        resolve(JSON.parse(data.toString()));
      });
      ws.on('error', reject);
      setTimeout(() => {
        ws.close();
        reject(new Error('timeout'));
      }, 5000);
    });

    expect(msg.type).toBe('connected');
    expect(msg.timestamp).toBeTruthy();
  });
});
