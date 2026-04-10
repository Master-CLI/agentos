import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TaskManager } from '../src/pipeline/task-manager.js';
import { ReviewPipeline } from '../src/pipeline/review-pipeline.js';
import { classifyChangeLevel } from '../src/pipeline/change-classifier.js';
import { ReasoningRouter } from '../src/reasoning/router.js';
import { Daemon } from '../src/daemon.js';
import type { ReasoningProvider, ReasoningResult, ReasoningTask } from '../src/reasoning/types.js';
import type { FileDiff } from '../src/pipeline/types.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p3-'));
}

function initAgentosDir(dir: string): void {
  const d = path.join(dir, '.agentos');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ version: '0.1.0', providers: [], port: 0 }));
}

// Mock providers that return deterministic structured output
function mockProvider(name: string, result: Partial<ReasoningResult> = {}): ReasoningProvider {
  return {
    name: name as any,
    available: true,
    invoke: async (task: ReasoningTask): Promise<ReasoningResult> => ({
      task_id: task.id,
      provider: name as any,
      output: result.output ?? 'mock output',
      structured: result.structured ?? {
        files: [{ path: 'src/hello.ts', additions: 10, deletions: 0, content: 'export const hello = 1;' }],
        verdict: 'approve',
        concerns: [],
        passed: true,
        total: 1,
        failed: 0,
        test_files: ['test/hello.test.ts'],
      },
      confidence: result.confidence ?? 0.9,
      latency_ms: result.latency_ms ?? 100,
    }),
  };
}

// ─── 任务管理 ───

describe('Phase 3 — 任务管理', () => {
  it('创建任务后 status 为 queued, origin 为 user', () => {
    const tm = new TaskManager();
    const task = tm.create({ prompt: '添加 hello 接口', origin: 'user', projectId: 'test' });
    expect(task.status).toBe('queued');
    expect(task.origin).toBe('user');
    expect(task.id).toBeTruthy();
    expect(task.prompt).toBe('添加 hello 接口');
  });

  it('system origin 任务标记 source_suggestion_id', () => {
    const tm = new TaskManager();
    const task = tm.create({
      prompt: '修复漏洞',
      origin: 'system',
      projectId: 'test',
      sourceSuggestionId: 'SUG-001',
    });
    expect(task.origin).toBe('system');
    expect(task.source_suggestion_id).toBe('SUG-001');
  });

  it('list 返回所有任务，包含 origin 标记', () => {
    const tm = new TaskManager();
    tm.create({ prompt: 'a', origin: 'user', projectId: 'test' });
    tm.create({ prompt: 'b', origin: 'system', projectId: 'test' });
    const tasks = tm.list();
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.origin).sort()).toEqual(['system', 'user']);
  });

  it('updateStatus 正确更新状态', () => {
    const tm = new TaskManager();
    const task = tm.create({ prompt: 'x', origin: 'user', projectId: 'test' });
    tm.updateStatus(task.id, 'implementing');
    expect(tm.get(task.id)!.status).toBe('implementing');
  });
});

// ─── 变更级别判定 ───

describe('Phase 3 — 变更级别判定', () => {
  it('单文件 <50 行 → light', () => {
    const diffs: FileDiff[] = [{ path: 'a.ts', additions: 10, deletions: 5, content: '' }];
    expect(classifyChangeLevel(diffs, 1)).toBe('light');
  });

  it('多文件同模块 → standard', () => {
    const diffs: FileDiff[] = [
      { path: 'a.ts', additions: 20, deletions: 10, content: '' },
      { path: 'b.ts', additions: 20, deletions: 10, content: '' },
    ];
    expect(classifyChangeLevel(diffs, 1)).toBe('standard');
  });

  it('跨模块 → major', () => {
    const diffs: FileDiff[] = [{ path: 'a.ts', additions: 5, deletions: 0, content: '' }];
    expect(classifyChangeLevel(diffs, 2)).toBe('major');
  });

  it('改 interface 导出 → major', () => {
    const diffs: FileDiff[] = [{
      path: 'types.ts',
      additions: 3,
      deletions: 1,
      content: '+export interface UserProfile {\n+  name: string;\n+}',
    }];
    expect(classifyChangeLevel(diffs, 1)).toBe('major');
  });
});

// ─── 跨模型隔离 ───

describe('Phase 3 — 跨模型隔离', () => {
  it('3 个 provider 时，实现/测试/审核分别用不同 provider', () => {
    const router = new ReasoningRouter();
    router.registerProvider(mockProvider('claude-code'));
    router.registerProvider(mockProvider('codex'));
    router.registerProvider(mockProvider('gemini'));

    const rp = new ReviewPipeline({ router, taskManager: new TaskManager() });
    const alloc = rp.allocateProviders('standard');

    expect(alloc.implementer).not.toBe(alloc.tester);
    expect(alloc.tester).not.toBe(alloc.reviewer);
    expect(alloc.implementer).not.toBe(alloc.reviewer);
  });

  it('2 个 provider 时，实现与测试/审核不同', () => {
    const router = new ReasoningRouter();
    router.registerProvider(mockProvider('claude-code'));
    router.registerProvider(mockProvider('codex'));

    const rp = new ReviewPipeline({ router, taskManager: new TaskManager() });
    const alloc = rp.allocateProviders('standard');

    expect(alloc.implementer).not.toBe(alloc.tester);
  });

  it('major 级别 → 有 secondReviewer', () => {
    const router = new ReasoningRouter();
    router.registerProvider(mockProvider('claude-code'));
    router.registerProvider(mockProvider('codex'));
    router.registerProvider(mockProvider('gemini'));

    const rp = new ReviewPipeline({ router, taskManager: new TaskManager() });
    const alloc = rp.allocateProviders('major');

    expect(alloc.secondReviewer).toBeTruthy();
    expect(alloc.secondReviewer).not.toBe(alloc.implementer);
  });
});

// ─── 管线流转 ───

describe('Phase 3 — 管线流转', () => {
  it('完整管线: queued → implementing → testing → reviewing → awaiting_user', async () => {
    const router = new ReasoningRouter();
    router.registerProvider(mockProvider('claude-code'));
    router.registerProvider(mockProvider('codex'));
    router.registerProvider(mockProvider('gemini'));

    const tm = new TaskManager();
    const statusHistory: string[] = [];
    tm.events.on('task_status_changed', ({ status }) => statusHistory.push(status));

    const task = tm.create({ prompt: '添加 hello 接口', origin: 'user', projectId: 'test' });
    const rp = new ReviewPipeline({ router, taskManager: tm });
    await rp.execute(task.id);

    expect(statusHistory).toContain('implementing');
    expect(statusHistory).toContain('testing');
    expect(statusHistory).toContain('reviewing');
    expect(statusHistory).toContain('awaiting_user');

    const final = tm.get(task.id)!;
    expect(final.status).toBe('awaiting_user');
    expect(final.pipeline.implementation.provider).toBeTruthy();
    expect(final.pipeline.testing.provider).toBeTruthy();
    expect(final.pipeline.reviews.length).toBeGreaterThanOrEqual(1);
  });

  it('审核报告包含 reviewer, verdict, concerns', async () => {
    const router = new ReasoningRouter();
    router.registerProvider(mockProvider('claude-code'));
    router.registerProvider(mockProvider('codex'));
    router.registerProvider(mockProvider('gemini'));

    const tm = new TaskManager();
    const task = tm.create({ prompt: 'test', origin: 'user', projectId: 'test' });
    const rp = new ReviewPipeline({ router, taskManager: tm });
    await rp.execute(task.id);

    const final = tm.get(task.id)!;
    const review = final.pipeline.reviews[0];
    expect(review.reviewer).toBeTruthy();
    expect(review.verdict).toBeTruthy();
    expect(Array.isArray(review.concerns)).toBe(true);
  });

  it('自动修复循环: error concern → fix_attempts 递增，最多 2 轮', async () => {
    // Provider that always returns error concerns
    const errorProvider: ReasoningProvider = {
      name: 'claude-code' as any,
      available: true,
      invoke: async (task) => ({
        task_id: task.id,
        provider: 'claude-code',
        output: 'error found',
        structured: {
          files: [{ path: 'a.ts', additions: 1, deletions: 0, content: 'x' }],
          verdict: 'reject',
          concerns: [{ file: 'a.ts', severity: 'error', category: 'logic', message: 'bug' }],
          passed: true, total: 1, failed: 0, test_files: ['t.ts'],
        },
        confidence: 0.9,
        latency_ms: 10,
      }),
    };

    const router = new ReasoningRouter();
    router.registerProvider(errorProvider);
    router.registerProvider({ ...errorProvider, name: 'codex' as any });
    router.registerProvider({ ...errorProvider, name: 'gemini' as any });

    const tm = new TaskManager();
    const task = tm.create({ prompt: 'test', origin: 'user', projectId: 'test' });
    const rp = new ReviewPipeline({ router, taskManager: tm });
    await rp.execute(task.id);

    const final = tm.get(task.id)!;
    expect(final.pipeline.fix_attempts).toBeLessThanOrEqual(2);
    expect(final.status).toBe('awaiting_user'); // Doesn't loop forever
  });
});

// ─── REST API ───

describe('Phase 3 — REST API', () => {
  let daemon: Daemon;
  let projectDir: string;
  let baseUrl: string;

  beforeAll(async () => {
    projectDir = tmpDir();
    initAgentosDir(projectDir);
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;

    // Inject TaskManager into server
    const tm = new TaskManager();
    (daemon as any).apiServer.setTaskManager(tm);
    (daemon as any).taskManager = tm;
  });

  afterAll(async () => {
    await daemon.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('POST /api/dialog → 201 + task_id', async () => {
    const res = await fetch(`${baseUrl}/api/dialog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '添加 hello 接口' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.task_id).toBeTruthy();
  });

  it('GET /api/tasks → 返回数组，包含 origin 标记', async () => {
    const res = await fetch(`${baseUrl}/api/tasks`);
    expect(res.status).toBe(200);
    const tasks = await res.json() as any[];
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].origin).toBe('user');
  });

  it('GET /api/tasks/:id → 包含 pipeline 字段', async () => {
    const tasks = await (await fetch(`${baseUrl}/api/tasks`)).json() as any[];
    const id = tasks[0].id;
    const res = await fetch(`${baseUrl}/api/tasks/${id}`);
    expect(res.status).toBe(200);
    const task = await res.json() as any;
    expect(task.pipeline).toBeTruthy();
    expect(task.pipeline.implementation).toBeTruthy();
  });

  it('POST /api/tasks/:id/accept → status 变为 completed', async () => {
    const tasks = await (await fetch(`${baseUrl}/api/tasks`)).json() as any[];
    const id = tasks[0].id;
    const res = await fetch(`${baseUrl}/api/tasks/${id}/accept`, { method: 'POST' });
    expect(res.status).toBe(200);
    const task = await res.json() as any;
    expect(task.status).toBe('completed');
  });

  it('POST /api/tasks/:id/discard → status 变为 cancelled', async () => {
    // Create a new task to discard
    const createRes = await fetch(`${baseUrl}/api/dialog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'to discard' }),
    });
    const { task_id } = await createRes.json() as any;

    const res = await fetch(`${baseUrl}/api/tasks/${task_id}/discard`, { method: 'POST' });
    expect(res.status).toBe(200);
    const task = await res.json() as any;
    expect(task.status).toBe('cancelled');
  });

  it('GET /api/tasks/nonexistent → 404', async () => {
    const res = await fetch(`${baseUrl}/api/tasks/NONEXISTENT`);
    expect(res.status).toBe(404);
  });
});
