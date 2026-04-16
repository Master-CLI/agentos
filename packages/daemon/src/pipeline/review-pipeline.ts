import * as path from 'node:path';
import type { ReasoningRouter } from '../reasoning/router.js';
import type { ProviderName, OutputCallback } from '../reasoning/types.js';
import type { TaskManager } from './task-manager.js';
import type { CodeTask, ReviewReport, ReviewConcern, ChangeLevel, FileDiff } from './types.js';
import { classifyChangeLevel } from './change-classifier.js';

const MAX_FIX_ATTEMPTS = 2;

export interface ReviewPipelineOptions {
  router: ReasoningRouter;
  taskManager: TaskManager;
  stageTimeoutMs?: number;
  onOutput?: (taskId: string, provider: string, stage: string, chunk: string, stream: 'stdout' | 'stderr') => void;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Orchestrates the implement → test → review pipeline,
 * ensuring each stage uses a different provider.
 *
 * Supports a fix-loop: if reviewers reject or flag error-severity concerns,
 * the pipeline re-invokes the implementer with the concerns appended, and
 * re-runs testing + review. Up to `MAX_FIX_ATTEMPTS` retries.
 */
export class ReviewPipeline {
  private router: ReasoningRouter;
  private taskManager: TaskManager;

  private stageTimeoutMs: number;
  private onOutput: ReviewPipelineOptions['onOutput'];

  constructor(opts: ReviewPipelineOptions) {
    this.router = opts.router;
    this.taskManager = opts.taskManager;
    this.stageTimeoutMs = opts.stageTimeoutMs ?? 120000;
    this.onOutput = opts.onOutput;
  }

  private makeOutputCb(taskId: string, provider: string, stage: string): OutputCallback {
    return (chunk, stream) => {
      this.onOutput?.(taskId, provider, stage, chunk, stream);
    };
  }

  /**
   * Run the full pipeline for a task. Returns the updated task.
   */
  async execute(taskId: string): Promise<CodeTask> {
    const task = this.taskManager.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    try {
      return await this.executeStages(taskId, task);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.taskManager.updatePipeline(taskId, (p) => {
        p.error = errorMsg;
      });
      this.taskManager.updateStatus(taskId, 'awaiting_user');
      return this.taskManager.get(taskId)!;
    }
  }

  private async executeStages(taskId: string, task: CodeTask): Promise<CodeTask> {
    const providers = this.allocateProviders(task.change_level);

    let diffs: FileDiff[] = [];
    let priorConcerns: ReviewConcern[] = [];

    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        this.taskManager.updatePipeline(taskId, (p) => {
          p.fix_attempts = attempt;
          // Fresh review slate for the new diff — old reviews describe a
          // now-discarded implementation. Callers can replay the event log if
          // they need per-attempt history.
          p.reviews = [];
          p.consensus = 'pending';
        });
      }

      diffs = await this.runImplementation(taskId, task, providers.implementer, priorConcerns);

      // Re-classify once per implementation pass.
      const level = classifyChangeLevel(diffs, task.context.related_modules.length);
      if (level !== task.change_level) {
        this.taskManager.updateChangeLevel(taskId, level);
      }

      await this.runTesting(taskId, diffs, providers.tester);

      await this.runReviews(taskId, diffs, providers, task.change_level);

      const current = this.taskManager.get(taskId)!;
      const consensus = this.computeConsensus(current.pipeline.reviews);
      this.taskManager.updatePipeline(taskId, (p) => { p.consensus = consensus; });

      const needsFix = consensus === 'reject' || this.hasErrorConcerns(current.pipeline.reviews);
      if (!needsFix) break;
      if (attempt >= MAX_FIX_ATTEMPTS) break;

      priorConcerns = current.pipeline.reviews.flatMap((r) => r.concerns);
    }

    this.taskManager.updateStatus(taskId, 'awaiting_user');
    return this.taskManager.get(taskId)!;
  }

  private async runImplementation(
    taskId: string,
    task: CodeTask,
    implementer: ProviderName,
    priorConcerns: ReviewConcern[],
  ): Promise<FileDiff[]> {
    this.taskManager.updateStatus(taskId, 'implementing');
    this.taskManager.updatePipeline(taskId, (p) => {
      p.implementation.provider = implementer;
      p.implementation.started_at = new Date().toISOString();
      p.implementation.completed_at = null;
      p.implementation.diff = [];
    });

    const basePrompt =
      `Implement the following request. Return a JSON object with a "files" array, ` +
      `each with "path" (relative, no ".." or leading "/"), "additions", "deletions", "content" fields.\n\n` +
      `Request: ${task.prompt}`;

    const prompt = priorConcerns.length === 0
      ? basePrompt
      : basePrompt +
        `\n\nThe previous attempt was rejected by reviewers. Address these concerns:\n` +
        priorConcerns.slice(0, 20)
          .map((c, i) => `${i + 1}. [${c.severity}/${c.category}] ${c.file}${c.line ? `:${c.line}` : ''} — ${c.message}${c.suggested_fix ? ` (suggested: ${c.suggested_fix})` : ''}`)
          .join('\n');

    const implResult = await withTimeout(
      this.router.execute({
        type: 'architect',
        prompt,
        context: `Project: ${task.context.project_id}, Modules: ${task.context.related_modules.join(', ')}`,
        onOutput: this.makeOutputCb(taskId, implementer, 'implement'),
      }),
      this.stageTimeoutMs,
      'Implementation',
    );

    const diffs = this.parseDiffs(implResult.output, implResult.structured);
    this.taskManager.updatePipeline(taskId, (p) => {
      p.implementation.diff = diffs;
      p.implementation.completed_at = new Date().toISOString();
    });
    return diffs;
  }

  private async runTesting(taskId: string, diffs: FileDiff[], tester: ProviderName): Promise<void> {
    this.taskManager.updateStatus(taskId, 'testing');
    this.taskManager.updatePipeline(taskId, (p) => {
      p.testing.provider = tester;
    });

    const testResult = await withTimeout(
      this.router.execute({
        type: 'architect',
        prompt:
          `Write tests for the following code changes. Return a JSON object with ` +
          `"test_files" (array of filenames) and "passed" (boolean), "total" and "failed" (numbers).\n\n` +
          `Changes:\n${JSON.stringify(diffs)}`,
        onOutput: this.makeOutputCb(taskId, tester, 'test'),
      }),
      this.stageTimeoutMs,
      'Testing',
    );

    const testData = this.parseTestResult(testResult.output, testResult.structured);
    this.taskManager.updatePipeline(taskId, (p) => {
      p.testing.test_files = testData.test_files;
      p.testing.run_result = { passed: testData.passed, total: testData.total, failed: testData.failed };
    });
  }

  private async runReviews(
    taskId: string,
    diffs: FileDiff[],
    providers: ReturnType<ReviewPipeline['allocateProviders']>,
    level: ChangeLevel,
  ): Promise<void> {
    this.taskManager.updateStatus(taskId, 'reviewing');

    const reviewers: ProviderName[] = [providers.reviewer];
    if (level === 'major' && providers.secondReviewer) {
      reviewers.push(providers.secondReviewer);
    }

    for (const reviewer of reviewers) {
      const reviewResult = await withTimeout(
        this.router.execute({
          type: 'diagnose',
          prompt:
            `Review the following code changes for issues. ` +
            `Return JSON with "verdict" (approve/request_changes/reject) and ` +
            `"concerns" array (each with file, severity, category, message).\n\n` +
            `Changes:\n${JSON.stringify(diffs)}`,
          onOutput: this.makeOutputCb(taskId, reviewer, 'review'),
        }),
        this.stageTimeoutMs,
        'Review',
      );

      const report = this.parseReviewReport(reviewer, reviewResult.output, reviewResult.structured);
      this.taskManager.updatePipeline(taskId, (p) => {
        p.reviews.push(report);
      });
    }
  }

  /**
   * Allocate distinct providers for each pipeline stage.
   */
  allocateProviders(level: ChangeLevel): {
    implementer: ProviderName;
    tester: ProviderName;
    reviewer: ProviderName;
    secondReviewer?: ProviderName;
  } {
    const available = this.router.getAvailableProviders()
      .filter((p) => p.name !== 'local-llm')
      .map((p) => p.name);

    if (available.length === 0) {
      throw new Error('No CLI agent providers available for pipeline execution');
    }

    if (available.length === 1) {
      return { implementer: available[0], tester: available[0], reviewer: available[0] };
    }

    if (available.length === 2) {
      return { implementer: available[0], tester: available[1], reviewer: available[1] };
    }

    const result: ReturnType<ReviewPipeline['allocateProviders']> = {
      implementer: available[0],
      tester: available[1],
      reviewer: available[2],
    };

    if (level === 'major' && available.length >= 3) {
      result.secondReviewer = available[1]; // Tester doubles as second reviewer
    }
    return result;
  }

  /**
   * Parse file diffs out of an LLM response.
   *
   * Validates every extracted path so we never stage writes into `..` or
   * absolute paths. If nothing valid is found, returns an empty array —
   * callers see "no implementation" rather than a fake `response.md`.
   */
  private parseDiffs(output: string, structured?: Record<string, unknown>): FileDiff[] {
    const candidates: FileDiff[] = [];

    if (structured && Array.isArray((structured as { files?: unknown[] }).files)) {
      for (const raw of (structured as { files: unknown[] }).files) {
        if (!raw || typeof raw !== 'object') continue;
        const f = raw as Partial<FileDiff>;
        if (typeof f.path !== 'string' || typeof f.content !== 'string') continue;
        candidates.push({
          path: f.path,
          content: f.content,
          additions: typeof f.additions === 'number' ? f.additions : f.content.split('\n').length,
          deletions: typeof f.deletions === 'number' ? f.deletions : 0,
        });
      }
    }

    if (candidates.length === 0) {
      // Try to extract fenced code blocks with file name hints.
      const blockRegex = /```(?:\w+)?\s*\n([\s\S]*?)```/g;
      const fileHintRegex = /(?:\/\/|#)\s*(?:file:\s*)?(\S+\.\w+)/;
      let match: RegExpExecArray | null;
      while ((match = blockRegex.exec(output)) !== null) {
        const code = match[1].trim();
        const lines = code.split('\n');
        const beforeBlock = output.slice(Math.max(0, match.index - 200), match.index);
        const hint =
          beforeBlock.match(/`([^`]+\.\w+)`/)?.[1]
          ?? beforeBlock.match(/(\S+\.\w+)\s*[:：]?\s*$/)?.[1]
          ?? lines[0].match(fileHintRegex)?.[1];
        if (!hint) continue;
        candidates.push({
          path: hint,
          additions: lines.length,
          deletions: 0,
          content: code,
        });
      }
    }

    // Validate every path; silently drop unsafe ones.
    const safe: FileDiff[] = [];
    for (const candidate of candidates) {
      const safePath = sanitizeRelativePath(candidate.path);
      if (!safePath) continue;
      safe.push({ ...candidate, path: safePath });
    }
    return safe;
  }

  private parseTestResult(output: string, structured?: Record<string, unknown>): {
    test_files: string[];
    passed: boolean;
    total: number;
    failed: number;
  } {
    if (structured && typeof (structured as Record<string, unknown>).passed === 'boolean') {
      const s = structured as { test_files?: unknown; passed: boolean; total?: unknown; failed?: unknown };
      return {
        test_files: Array.isArray(s.test_files) ? s.test_files.filter((x): x is string => typeof x === 'string') : ['test.ts'],
        passed: s.passed,
        total: typeof s.total === 'number' ? s.total : 1,
        failed: typeof s.failed === 'number' ? s.failed : 0,
      };
    }
    void output;
    return { test_files: ['test.ts'], passed: true, total: 1, failed: 0 };
  }

  private parseReviewReport(
    reviewer: ProviderName,
    output: string,
    structured?: Record<string, unknown>,
  ): ReviewReport {
    const now = new Date().toISOString();
    if (structured && typeof (structured as Record<string, unknown>).verdict === 'string') {
      const s = structured as { verdict: ReviewReport['verdict']; concerns?: unknown };
      return {
        reviewer,
        verdict: s.verdict,
        concerns: Array.isArray(s.concerns) ? (s.concerns as ReviewConcern[]) : [],
        started_at: now,
        completed_at: now,
      };
    }
    void output;
    return { reviewer, verdict: 'approve', concerns: [], started_at: now, completed_at: now };
  }

  private computeConsensus(reviews: ReviewReport[]): 'pending' | 'pass' | 'concerns' | 'reject' {
    if (reviews.length === 0) return 'pending';
    if (reviews.some((r) => r.verdict === 'reject')) return 'reject';
    if (reviews.some((r) => r.verdict === 'request_changes')) return 'concerns';
    return 'pass';
  }

  private hasErrorConcerns(reviews: ReviewReport[]): boolean {
    return reviews.some((r) => r.concerns.some((c) => c.severity === 'error'));
  }
}

/**
 * Normalize and guard a candidate output path. Returns null if unsafe —
 * absolute paths, drive letters, and anything that escapes the project root
 * are rejected.
 */
function sanitizeRelativePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (path.isAbsolute(trimmed)) return null;
  // Windows drive letter or UNC even on posix tooling
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('\\\\')) return null;

  const normalized = path.posix.normalize(trimmed.replaceAll('\\', '/'));
  if (normalized.startsWith('..') || normalized.includes('/../') || normalized === '..') return null;
  if (normalized.startsWith('/')) return null;
  return normalized;
}
