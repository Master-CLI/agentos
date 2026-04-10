export type TaskType = 'classify' | 'summarize' | 'interpret' | 'diagnose' | 'coordinate' | 'architect';
export type ProviderName = 'local-llm' | 'claude-code' | 'codex' | 'gemini';

export interface ReasoningTask {
  id: string;
  type: TaskType;
  prompt: string;
  input: {
    context?: string;
  };
  constraints: {
    max_latency_ms: number;
    min_confidence: number;
  };
}

export interface ReasoningResult {
  task_id: string;
  provider: ProviderName;
  output: string;
  structured?: Record<string, unknown>;
  confidence: number;
  latency_ms: number;
}

export type OutputCallback = (chunk: string, stream: 'stdout' | 'stderr') => void;

export interface ReasoningProvider {
  name: ProviderName;
  available: boolean;
  invoke(task: ReasoningTask, onOutput?: OutputCallback): Promise<ReasoningResult>;
}
