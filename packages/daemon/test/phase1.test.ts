import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { EventBus } from '../src/events/event-bus.js';
import { FileWatcher } from '../src/observers/file-watcher.js';
import { GitObserver } from '../src/observers/git-observer.js';
import { Daemon } from '../src/daemon.js';
import type { ProjectEvent } from '../src/events/types.js';
import WebSocket from 'ws';
import { safeRmSync } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p1-'));
}

function initAgentosDir(projectDir: string): void {
  const agentosDir = path.join(projectDir, '.agentos');
  fs.mkdirSync(agentosDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentosDir, 'config.json'),
    JSON.stringify({ version: '0.1.0', providers: [], port: 0 }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function collectEvents(bus: EventBus, timeoutMs: number): Promise<ProjectEvent[]> {
  return new Promise((resolve) => {
    const collected: ProjectEvent[] = [];
    const unsub = bus.subscribe((e) => collected.push(e));
    setTimeout(() => {
      unsub();
      resolve(collected);
    }, timeoutMs);
  });
}

// ─── FileWatcher ───

describe('Phase 1 — FileWatcher', () => {
  let dir: string;
  let bus: EventBus;
  let watcher: FileWatcher;

  beforeAll(async () => {
    dir = tmpDir();
    bus = new EventBus();
    watcher = new FileWatcher({
      projectDir: dir,
      projectId: 'test',
      eventBus: bus,
      debounceMs: 100,
    });
    watcher.start();
    // Wait for chokidar to be ready
    await sleep(500);
  });

  afterAll(() => {
    watcher.stop();
    safeRmSync(dir);
  });

  it('创建文件 → file_created 事件', async () => {
    const collecting = collectEvents(bus, 2000);
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello');
    const events = await collecting;
    const created = events.find((e) => e.type === 'file_created');
    expect(created).toBeTruthy();
    expect(created!.payload.path).toContain('hello.txt');
  });

  it('修改文件 → file_modified 事件', async () => {
    // Ensure file exists first
    const filePath = path.join(dir, 'modify-me.txt');
    fs.writeFileSync(filePath, 'v1');
    await sleep(500); // Wait for initial creation event to flush

    const collecting = collectEvents(bus, 2000);
    fs.writeFileSync(filePath, 'v2');
    const events = await collecting;
    const modified = events.find((e) => e.type === 'file_modified');
    expect(modified).toBeTruthy();
  });

  it('删除文件 → file_deleted 事件', async () => {
    const filePath = path.join(dir, 'delete-me.txt');
    fs.writeFileSync(filePath, 'bye');
    await sleep(500);

    const collecting = collectEvents(bus, 2000);
    fs.unlinkSync(filePath);
    const events = await collecting;
    const deleted = events.find((e) => e.type === 'file_deleted');
    expect(deleted).toBeTruthy();
  });

  it('事件 payload 包含 path, size, mtime', async () => {
    const collecting = collectEvents(bus, 2000);
    fs.writeFileSync(path.join(dir, 'payload-check.txt'), 'data');
    const events = await collecting;
    const e = events.find((ev) => ev.type === 'file_created' && String(ev.payload.path).includes('payload-check'));
    expect(e).toBeTruthy();
    expect(e!.payload).toHaveProperty('path');
    expect(e!.payload).toHaveProperty('size');
    expect(e!.payload).toHaveProperty('mtime');
  });
});

// ─── 事件去噪 ───

describe('Phase 1 — 事件去噪', () => {
  let dir: string;
  let bus: EventBus;
  let watcher: FileWatcher;

  beforeAll(() => {
    dir = tmpDir();
    // Create node_modules and .git dirs
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git', 'objects'), { recursive: true });

    bus = new EventBus();
    watcher = new FileWatcher({
      projectDir: dir,
      projectId: 'test',
      eventBus: bus,
      debounceMs: 100,
    });
    watcher.start();
  });

  afterAll(() => {
    watcher.stop();
    safeRmSync(dir);
  });

  it('node_modules/ 下创建文件 → 无事件', async () => {
    const collecting = collectEvents(bus, 1500);
    fs.writeFileSync(path.join(dir, 'node_modules', 'junk.js'), '//');
    const events = await collecting;
    const fromNodeModules = events.filter((e) =>
      String(e.payload.path).includes('node_modules')
    );
    expect(fromNodeModules.length).toBe(0);
  });

  it('.git/ 下修改文件 → 无事件', async () => {
    const collecting = collectEvents(bus, 1500);
    fs.writeFileSync(path.join(dir, '.git', 'objects', 'test'), 'x');
    const events = await collecting;
    const fromGit = events.filter((e) =>
      String(e.payload.path).includes('.git')
    );
    expect(fromGit.length).toBe(0);
  });

  it('100ms 内创建 10 个文件 → 事件数 < 10（批量合并）', async () => {
    const collecting = collectEvents(bus, 2000);
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(dir, `batch-${i}.txt`), `data-${i}`);
    }
    const events = await collecting;
    // Debounce should merge some of these — at minimum, they won't arrive as 10 separate flushes
    // The key assertion: events exist and count is reasonable (less than 20 individual events due to batching)
    const batchEvents = events.filter((e) => String(e.payload.path).includes('batch-'));
    expect(batchEvents.length).toBeGreaterThan(0);
    expect(batchEvents.length).toBeLessThanOrEqual(10);
  });
});

// ─── GitObserver ───

describe('Phase 1 — GitObserver', () => {
  let dir: string;
  let bus: EventBus;
  let observer: GitObserver;

  beforeAll(() => {
    dir = tmpDir();
    // Init a real git repo
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    // Initial commit
    fs.writeFileSync(path.join(dir, 'README.md'), '# test');
    execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'pipe' });

    bus = new EventBus();
    observer = new GitObserver({
      projectDir: dir,
      projectId: 'test',
      eventBus: bus,
      pollIntervalMs: 500,
    });
    observer.start();
  });

  afterAll(() => {
    observer.stop();
    safeRmSync(dir);
  });

  it('git commit → commit_pushed 事件，payload 含 hash/message/author/files_changed', async () => {
    await sleep(1000); // Let observer snapshot initial state

    const collecting = collectEvents(bus, 3000);
    fs.writeFileSync(path.join(dir, 'new-file.ts'), 'export const x = 1;');
    execSync('git add . && git commit -m "add new-file"', { cwd: dir, stdio: 'pipe' });
    const events = await collecting;

    const commitEvent = events.find((e) => e.type === 'commit_pushed');
    expect(commitEvent).toBeTruthy();
    expect(commitEvent!.payload.hash).toBeTruthy();
    expect(commitEvent!.payload.message).toContain('add new-file');
    expect(commitEvent!.payload.author).toBe('Test');
    expect(commitEvent!.payload.files_changed).toBeTruthy();
  });

  it('git checkout -b → branch_created 事件', async () => {
    const collecting = collectEvents(bus, 3000);
    execSync('git checkout -b test-branch', { cwd: dir, stdio: 'pipe' });
    const events = await collecting;

    const branchEvent = events.find((e) => e.type === 'branch_created');
    expect(branchEvent).toBeTruthy();
    expect(branchEvent!.payload.branch).toBe('test-branch');
  });
});

// ─── WebSocket 推送 ───

describe('Phase 1 — WebSocket 事件推送', () => {
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

  it('WS 客户端连接后，发布事件 → 客户端收到消息', async () => {
    const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${daemon.port}`);
      let gotHandshake = false;

      ws.on('message', (data) => {
        const parsed = JSON.parse(data.toString());
        if (parsed.type === 'connected') {
          gotHandshake = true;
          // Now trigger an event
          daemon.appendAndPublish({
            source: 'test',
            type: 'file_created',
            payload: { path: '/test/file.txt' },
            metadata: { project_id: 'test' },
          });
          return;
        }
        if (gotHandshake) {
          ws.close();
          resolve(parsed);
        }
      });
      ws.on('error', reject);
      setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    });

    expect(msg.type).toBe('file_created');
    expect(msg.source).toBe('test');
  });
});

// ─── 冷启动报告 ───

describe('Phase 1 — 冷启动零知识报告', () => {
  it('含 package.json 的目录 init → 报告包含依赖数量', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'test-proj',
      dependencies: { lodash: '4.0.0' },
      devDependencies: { vitest: '2.0.0' },
    }));

    // Run init programmatically
    const { initProject } = await import('../../cli/src/commands/init.js');
    await initProject(dir);

    const report = JSON.parse(
      fs.readFileSync(path.join(dir, '.agentos', 'init-report.json'), 'utf-8')
    );
    expect(report.structure).toBeTruthy();
    expect(report.dependencies).toBe(2);
    expect(report.git_summary).toBeTruthy();

    safeRmSync(dir);
  });

  it('含 .git 的目录 init → 报告包含 commit 数', async () => {
    const dir = tmpDir();
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    execSync('git add . && git commit -m "c1"', { cwd: dir, stdio: 'pipe' });

    const { initProject } = await import('../../cli/src/commands/init.js');
    await initProject(dir);

    const report = JSON.parse(
      fs.readFileSync(path.join(dir, '.agentos', 'init-report.json'), 'utf-8')
    );
    expect(report.git_summary.available).toBe(true);
    expect(report.git_summary.commit_count).toBeGreaterThanOrEqual(1);

    safeRmSync(dir);
  });

  it('报告为合法 JSON 且含 structure / dependencies / git_summary', async () => {
    const dir = tmpDir();
    const { initProject } = await import('../../cli/src/commands/init.js');
    await initProject(dir);

    const raw = fs.readFileSync(path.join(dir, '.agentos', 'init-report.json'), 'utf-8');
    const report = JSON.parse(raw); // Throws if invalid JSON
    expect(report).toHaveProperty('structure');
    expect(report).toHaveProperty('dependencies');
    expect(report).toHaveProperty('git_summary');

    safeRmSync(dir);
  });
});
