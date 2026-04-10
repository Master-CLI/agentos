import { ulid } from 'ulid';
import type { ReasoningProvider, ReasoningTask, ReasoningResult, TaskType, ProviderName, OutputCallback } from './types.js';

/**
 * Routes reasoning tasks to the appropriate provider based on task type,
 * provider availability, and historical accuracy.
 */
export class ReasoningRouter {
  private providers: Map<ProviderName, ReasoningProvider> = new Map();

  // Default routing rules: task type → preferred provider
  private static readonly ROUTING_TABLE: Record<TaskType, ProviderName> = {
    classify: 'local-llm',
    summarize: 'local-llm',
    interpret: 'local-llm',
    diagnose: 'claude-code',
    coordinate: 'claude-code',
    architect: 'claude-code',
  };

  // CLI agent fallback order
  private static readonly CLI_FALLBACK: ProviderName[] = ['claude-code', 'codex', 'gemini'];

  registerProvider(provider: ReasoningProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProviders(): ReasoningProvider[] {
    return Array.from(this.providers.values());
  }

  getAvailableProviders(): ReasoningProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.available);
  }

  /**
   * Determine which provider should handle a given task type.
   */
  route(taskType: TaskType): ProviderName | null {
    const preferred = ReasoningRouter.ROUTING_TABLE[taskType];

    // Check if preferred provider is available
    const provider = this.providers.get(preferred);
    if (provider?.available) {
      return preferred;
    }

    // If preferred was local-llm but unavailable, try to stay on local (no fallback to CLI for simple tasks)
    if (preferred === 'local-llm') {
      return null; // No local LLM → skip reasoning for this task
    }

    // For CLI agent tasks, try fallback chain
    for (const name of ReasoningRouter.CLI_FALLBACK) {
      const fallback = this.providers.get(name);
      if (fallback?.available) {
        return name;
      }
    }

    return null; // No providers available
  }

  /**
   * Create a task, route it, and invoke the chosen provider.
   */
  async execute(opts: {
    type: TaskType;
    prompt: string;
    context?: string;
    maxLatencyMs?: number;
    minConfidence?: number;
    onOutput?: OutputCallback;
  }): Promise<ReasoningResult> {
    const providerName = this.route(opts.type);
    if (!providerName) {
      throw new Error(`No available provider for task type '${opts.type}'`);
    }

    const provider = this.providers.get(providerName)!;

    const task: ReasoningTask = {
      id: ulid(),
      type: opts.type,
      prompt: opts.prompt,
      input: { context: opts.context },
      constraints: {
        max_latency_ms: opts.maxLatencyMs ?? 30000,
        min_confidence: opts.minConfidence ?? 0,
      },
    };

    return provider.invoke(task, opts.onOutput);
  }
}
