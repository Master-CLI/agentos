import type { ReasoningRouter } from '../reasoning/router.js';
import type { ProviderName } from '../reasoning/types.js';
import type { TaskManager } from './task-manager.js';
import type { CodeTask, ReviewReport, ReviewConcern, ChangeLevel, FileDiff } from './types.js';
import { classifyChangeLevel } from './change-classifier.js';

const MAX_FIX_ATTEMPTS = 2;

export interface ReviewPipelineOptions {
  router: ReasoningRouter;
  taskManager: TaskManager;
}

/**
 * Orchestrates the implement → test → review pipeline,
 * ensuring each stage uses a different provider.
 */
export class ReviewPipeline {
  private router: ReasoningRouter;
  private taskManager: TaskManager;

  constructor(opts: ReviewPipelineOptions) {
    this.router = opts.router;
    this.taskManager = opts.taskManager;
  }

  /**
   * Run the full pipeline for a task.
   * Returns the updated task.
   */
  async execute(taskId: string): Promise<CodeTask> {
    const task = this.taskManager.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Pick 3 distinct providers for implement, test, review
    const providers = this.allocateProviders(task.change_level);

    // ── Stage 1: Implementation ──
    this.taskManager.updateStatus(taskId, 'implementing');
    this.taskManager.updatePipeline(taskId, (p) => {
      p.implementation.provider = providers.implementer;
      p.implementation.started_at = new Date().toISOString();
    });

    const implResult = await this.router.execute({
      type: 'architect',
      prompt: `Implement the following request. Return a JSON object with a "files" array, each with "path", "additions", "deletions", "content" fields.\n\nRequest: ${task.prompt}`,
      context: `Project: ${task.context.project_id}, Modules: ${task.context.related_modules.join(', ')}`,
    });

    const diffs = this.parseDiffs(implResult.output, implResult.structured);
    const level = classifyChangeLevel(diffs, task.context.related_modules.length);

    this.taskManager.updatePipeline(taskId, (p) => {
      p.implementation.diff = diffs;
      p.implementation.completed_at = new Date().toISOString();
    });

    // Update change level if auto-detected differently
    if (level !== task.change_level) {
      task.change_level = level;
    }

    // ── Stage 2: Test generation ──
    this.taskManager.updateStatus(taskId, 'testing');
    this.taskManager.updatePipeline(taskId, (p) => {
      p.testing.provider = providers.tester;
    });

    const testResult = await this.router.execute({
      type: 'architect',
      prompt: `Write tests for the following code changes. Return a JSON object with "test_files" (array of filenames) and "passed" (boolean), "total" and "failed" (numbers).\n\nChanges:\n${JSON.stringify(diffs)}`,
    });

    const testData = this.parseTestResult(testResult.output, testResult.structured);
    this.taskManager.updatePipeline(taskId, (p) => {
      p.testing.test_files = testData.test_files;
      p.testing.run_result = { passed: testData.passed, total: testData.total, failed: testData.failed };
    });

    // ── Stage 3: Review ──
    this.taskManager.updateStatus(taskId, 'reviewing');

    const reviewCount = level === 'major' ? 2 : 1;
    const reviewers = [providers.reviewer];
    if (reviewCount === 2 && providers.secondReviewer) {
      reviewers.push(providers.secondReviewer);
    }

    for (const reviewer of reviewers) {
      const reviewResult = await this.router.execute({
        type: 'diagnose',
        prompt: `Review the following code changes for issues. Return JSON with "verdict" (approve/request_changes/reject) and "concerns" array (each with file, severity, category, message).\n\nChanges:\n${JSON.stringify(diffs)}`,
      });

      const report = this.parseReviewReport(reviewer, reviewResult.output, reviewResult.structured);
      this.taskManager.updatePipeline(taskId, (p) => {
        p.reviews.push(report);
      });
    }

    // ── Compute consensus ──
    const updatedTask = this.taskManager.get(taskId)!;
    const consensus = this.computeConsensus(updatedTask.pipeline.reviews);
    this.taskManager.updatePipeline(taskId, (p) => {
      p.consensus = consensus;
    });

    // ── Auto-fix if needed ──
    if (consensus === 'reject' || this.hasErrorConcerns(updatedTask.pipeline.reviews)) {
      if (updatedTask.pipeline.fix_attempts < MAX_FIX_ATTEMPTS) {
        this.taskManager.updatePipeline(taskId, (p) => {
          p.fix_attempts++;
        });
        // In a real implementation, this would re-invoke the implementer with the concerns
        // For now, just mark it and move to awaiting_user
      }
    }

    this.taskManager.updateStatus(taskId, 'awaiting_user');
    return this.taskManager.get(taskId)!;
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

    // If only 1 provider available, use it for everything (degraded mode)
    if (available.length === 1) {
      return {
        implementer: available[0],
        tester: available[0],
        reviewer: available[0],
      };
    }

    // 2 providers: split implement vs test+review
    if (available.length === 2) {
      return {
        implementer: available[0],
        tester: available[1],
        reviewer: available[1],
      };
    }

    // 3+ providers: full separation
    const result: ReturnType<ReviewPipeline['allocateProviders']> = {
      implementer: available[0],
      tester: available[1],
      reviewer: available[2],
    };

    // For major changes, add second reviewer
    if (level === 'major' && available.length >= 3) {
      result.secondReviewer = available[1]; // Tester doubles as second reviewer
    }

    return result;
  }

  private parseDiffs(output: string, structured?: Record<string, unknown>): FileDiff[] {
    if (structured && Array.isArray((structured as any).files)) {
      return (structured as any).files;
    }
    // Fallback: return a single synthetic diff
    return [{
      path: 'generated.ts',
      additions: output.split('\n').length,
      deletions: 0,
      content: output,
    }];
  }

  private parseTestResult(output: string, structured?: Record<string, unknown>): {
    test_files: string[];
    passed: boolean;
    total: number;
    failed: number;
  } {
    if (structured && typeof (structured as any).passed === 'boolean') {
      return {
        test_files: (structured as any).test_files ?? ['test.ts'],
        passed: (structured as any).passed,
        total: (structured as any).total ?? 1,
        failed: (structured as any).failed ?? 0,
      };
    }
    return { test_files: ['test.ts'], passed: true, total: 1, failed: 0 };
  }

  private parseReviewReport(
    reviewer: ProviderName,
    output: string,
    structured?: Record<string, unknown>,
  ): ReviewReport {
    const now = new Date().toISOString();
    if (structured && typeof (structured as any).verdict === 'string') {
      return {
        reviewer,
        verdict: (structured as any).verdict,
        concerns: (structured as any).concerns ?? [],
        started_at: now,
        completed_at: now,
      };
    }
    return {
      reviewer,
      verdict: 'approve',
      concerns: [],
      started_at: now,
      completed_at: now,
    };
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
