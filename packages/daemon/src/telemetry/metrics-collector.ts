import type { TaskManager } from '../pipeline/task-manager.js';
import type { ProviderName } from '../reasoning/types.js';

export interface SystemMetrics {
  tasks_total: number;
  tasks_by_status: Record<string, number>;
  tasks_by_origin: Record<string, number>;
  avg_pipeline_latency_ms: number;
  provider_usage: Record<string, number>;
  suggestions_total: number;
  suggestions_converted: number;
}

export interface TaskTrace {
  task_id: string;
  prompt: string;
  origin: string;
  status: string;
  created_at: string;
  change_level: string;
  pipeline: {
    implementer: string | null;
    tester: string | null;
    reviewers: string[];
    review_verdicts: string[];
    consensus: string;
    fix_attempts: number;
    diff_file_count: number;
    test_passed: boolean | null;
  };
}

export class MetricsCollector {
  private pipelineLatencies: number[] = [];
  private providerCalls: Map<string, number> = new Map();
  private suggestionStats = { total: 0, converted: 0 };

  recordPipelineLatency(ms: number): void {
    this.pipelineLatencies.push(ms);
  }

  recordProviderCall(provider: ProviderName | string): void {
    this.providerCalls.set(provider, (this.providerCalls.get(provider) ?? 0) + 1);
  }

  recordSuggestion(converted: boolean): void {
    this.suggestionStats.total++;
    if (converted) this.suggestionStats.converted++;
  }

  getMetrics(taskManager?: TaskManager): SystemMetrics {
    const tasks = taskManager?.list() ?? [];

    const byStatus: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      byOrigin[t.origin] = (byOrigin[t.origin] ?? 0) + 1;
    }

    const avgLatency = this.pipelineLatencies.length > 0
      ? this.pipelineLatencies.reduce((a, b) => a + b, 0) / this.pipelineLatencies.length
      : 0;

    return {
      tasks_total: tasks.length,
      tasks_by_status: byStatus,
      tasks_by_origin: byOrigin,
      avg_pipeline_latency_ms: Math.round(avgLatency),
      provider_usage: Object.fromEntries(this.providerCalls),
      suggestions_total: this.suggestionStats.total,
      suggestions_converted: this.suggestionStats.converted,
    };
  }

  getTaskTrace(taskManager: TaskManager, taskId: string): TaskTrace | null {
    const task = taskManager.get(taskId);
    if (!task) return null;

    return {
      task_id: task.id,
      prompt: task.prompt,
      origin: task.origin,
      status: task.status,
      created_at: task.created_at,
      change_level: task.change_level,
      pipeline: {
        implementer: task.pipeline.implementation.provider,
        tester: task.pipeline.testing.provider,
        reviewers: task.pipeline.reviews.map((r) => r.reviewer),
        review_verdicts: task.pipeline.reviews.map((r) => r.verdict),
        consensus: task.pipeline.consensus,
        fix_attempts: task.pipeline.fix_attempts,
        diff_file_count: task.pipeline.implementation.diff.length,
        test_passed: task.pipeline.testing.run_result?.passed ?? null,
      },
    };
  }
}
