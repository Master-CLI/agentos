import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SuggestionEngine } from '../src/suggestions/suggestion-engine.js';
import { TaskManager } from '../src/pipeline/task-manager.js';
import { ConfidenceCalibrator } from '../src/trust/confidence-calibrator.js';
import { DampingController } from '../src/trust/damping.js';
import { FeedbackTracker } from '../src/trust/feedback-tracker.js';
import { Daemon } from '../src/daemon.js';
import { safeRmSync } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-p4-'));
}
function initAgentosDir(dir: string): void {
  const d = path.join(dir, '.agentos');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({ version: '0.1.0', providers: [], port: 0 }));
}

// ─── 建议引擎 ───

describe('Phase 4 — 建议引擎', () => {
  it('创建建议 → 收件箱出现，status 为 pending', () => {
    const se = new SuggestionEngine();
    const s = se.create({
      category: 'ci_failure',
      summary: '测试失败归因',
      detail: 'tests/api.test.ts 第 42 行断言失败',
      evidence: ['test_failed event at 10:30', 'recent commit changed api handler'],
      confidence: 0.87,
      impact: 'medium',
    });
    expect(s.status).toBe('pending');
    expect(s.id).toBeTruthy();
    expect(se.list().length).toBe(1);
  });

  it('建议包含 evidence, confidence, impact', () => {
    const se = new SuggestionEngine();
    const s = se.create({
      category: 'dependency_drift',
      summary: 'lodash 存在已知漏洞',
      detail: 'CVE-2024-XXXX',
      evidence: ['npm audit output'],
      confidence: 0.95,
      impact: 'high',
    });
    expect(s.evidence.length).toBeGreaterThan(0);
    expect(s.confidence).toBe(0.95);
    expect(s.impact).toBe('high');
  });
});

// ─── 建议 → 任务转化 ───

describe('Phase 4 — 建议→任务转化', () => {
  it('convert 后创建 CodeTask，origin 为 system', () => {
    const tm = new TaskManager();
    const se = new SuggestionEngine(tm);
    const s = se.create({
      category: 'ci_failure',
      summary: '修复 CI 失败',
      detail: '详细...',
      evidence: ['e1'],
      confidence: 0.8,
      impact: 'medium',
    });
    const result = se.convertToTask(s.id);
    expect(result.task_id).toBeTruthy();

    const task = tm.get(result.task_id)!;
    expect(task.origin).toBe('system');
    expect(task.source_suggestion_id).toBe(s.id);
  });

  it('convert 后建议状态变为 converted', () => {
    const tm = new TaskManager();
    const se = new SuggestionEngine(tm);
    const s = se.create({ category: 'general', summary: 'x', detail: 'd', evidence: [], confidence: 0.5, impact: 'low' });
    se.convertToTask(s.id);
    expect(se.get(s.id)!.status).toBe('converted');
    expect(se.get(s.id)!.converted_task_id).toBeTruthy();
  });
});

// ─── 置信度校准 ───

describe('Phase 4 — 置信度校准', () => {
  it('连续 accept 5 条同类建议 → 该类 confidence 上调', () => {
    const cal = new ConfidenceCalibrator();
    for (let i = 0; i < 5; i++) cal.record('ci_failure', true);

    const adjusted = cal.adjust('ci_failure', 0.7);
    expect(adjusted).toBeGreaterThan(0.7); // Accept rate = 1.0, blended > raw
  });

  it('连续 reject 3 条同类建议 → 该类 confidence 下调', () => {
    const cal = new ConfidenceCalibrator();
    for (let i = 0; i < 3; i++) cal.record('dependency_drift', false);

    const adjusted = cal.adjust('dependency_drift', 0.8);
    expect(adjusted).toBeLessThan(0.8); // Accept rate = 0.0, blended < raw
  });

  it('confidence 值在 0-1 范围内', () => {
    const cal = new ConfidenceCalibrator();
    for (let i = 0; i < 10; i++) cal.record('test', true);
    const a1 = cal.adjust('test', 1.5); // Raw exceeds 1
    expect(a1).toBeLessThanOrEqual(1);
    expect(a1).toBeGreaterThanOrEqual(0);

    const cal2 = new ConfidenceCalibrator();
    for (let i = 0; i < 10; i++) cal2.record('test2', false);
    const a2 = cal2.adjust('test2', -0.5); // Raw below 0
    expect(a2).toBeGreaterThanOrEqual(0);
    expect(a2).toBeLessThanOrEqual(1);
  });
});

// ─── 告警疲劳防御 ───

describe('Phase 4 — 告警疲劳防御', () => {
  it('同区域 24h 内第 2 条建议 → 被 region_cooldown 抑制', () => {
    const dc = new DampingController({ cooldownMs: 86400000 });
    dc.recordSuggestion('src/auth.ts');
    const reason = dc.shouldSuppress('src/auth.ts');
    expect(reason).toBe('region_cooldown');
  });

  it('不同区域不受冷却影响', () => {
    const dc = new DampingController({ cooldownMs: 86400000 });
    dc.recordSuggestion('src/auth.ts');
    const reason = dc.shouldSuppress('src/payment.ts');
    expect(reason).toBeNull();
  });

  it('10s 内 5 条 commit → flow_active 抑制建议', () => {
    const dc = new DampingController({ flowThreshold: 5, flowWindowMs: 10000 });
    for (let i = 0; i < 5; i++) dc.recordCommit();
    const reason = dc.shouldSuppress();
    expect(reason).toBe('flow_active');
  });

  it('isInFlow 检测心流状态', () => {
    const dc = new DampingController({ flowThreshold: 3, flowWindowMs: 10000 });
    expect(dc.isInFlow()).toBe(false);
    for (let i = 0; i < 3; i++) dc.recordCommit();
    expect(dc.isInFlow()).toBe(true);
  });
});

// ─── 负向反馈 ───

describe('Phase 4 — 负向反馈', () => {
  it('任务被 discard → 记录 feedback 条目', () => {
    const ft = new FeedbackTracker();
    const entry = ft.record({
      type: 'task_discarded',
      source_id: 'TASK-001',
      provider: 'claude-code',
      user_action: 'discard',
    });
    expect(entry.id).toBeTruthy();
    expect(entry.type).toBe('task_discarded');
    expect(ft.list().length).toBe(1);
  });

  it('feedback 条目包含 source_id, provider, user_action', () => {
    const ft = new FeedbackTracker();
    ft.record({
      type: 'suggestion_rejected',
      source_id: 'SUG-001',
      category: 'ci_failure',
      user_action: 'reject',
    });
    const entry = ft.getBySource('SUG-001')[0];
    expect(entry.source_id).toBe('SUG-001');
    expect(entry.category).toBe('ci_failure');
    expect(entry.user_action).toBe('reject');
  });
});

// ─── Suggestion REST API ───

describe('Phase 4 — Suggestion API', () => {
  let daemon: Daemon;
  let projectDir: string;
  let baseUrl: string;
  let se: SuggestionEngine;

  beforeAll(async () => {
    projectDir = tmpDir();
    initAgentosDir(projectDir);
    daemon = new Daemon({ projectDir, port: 0 });
    await daemon.start();
    baseUrl = `http://localhost:${daemon.port}`;

    const tm = new TaskManager();
    se = new SuggestionEngine(tm);
    (daemon as any).apiServer.setTaskManager(tm);
    (daemon as any).apiServer.setSuggestionEngine(se);
  });

  afterAll(async () => {
    await daemon.stop();
    safeRmSync(projectDir);
  });

  it('GET /api/suggestions → 返回数组', async () => {
    se.create({ category: 'ci_failure', summary: 'test', detail: 'd', evidence: [], confidence: 0.8, impact: 'medium' });
    const res = await fetch(`${baseUrl}/api/suggestions`);
    expect(res.status).toBe(200);
    const body = await res.json() as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/suggestions/:id/convert → 创建任务', async () => {
    const s = se.create({ category: 'general', summary: 'to convert', detail: 'd', evidence: [], confidence: 0.7, impact: 'low' });
    const res = await fetch(`${baseUrl}/api/suggestions/${s.id}/convert`, { method: 'POST' });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.task_id).toBeTruthy();
    expect(body.suggestion.status).toBe('converted');
  });
});
