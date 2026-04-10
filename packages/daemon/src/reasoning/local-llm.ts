import type { ReasoningProvider, ReasoningTask, ReasoningResult } from './types.js';

export interface OllamaOptions {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

export class LocalLlmProvider implements ReasoningProvider {
  readonly name = 'local-llm' as const;
  available = false;
  private endpoint: string;
  private model: string;
  private timeoutMs: number;

  constructor(opts?: OllamaOptions) {
    this.endpoint = opts?.endpoint ?? 'http://localhost:11434';
    this.model = opts?.model ?? 'gemma4';
    this.timeoutMs = opts?.timeoutMs ?? 30000;
  }

  async checkAvailability(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${this.endpoint}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      this.available = res.ok;
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  async invoke(task: ReasoningTask): Promise<ReasoningResult> {
    const start = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: task.prompt,
          stream: false,
          options: {
            temperature: 0.3,
            num_predict: 2048,
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
      }

      const body = await res.json() as { response: string };
      const latency = Date.now() - start;

      // Try to parse structured JSON from output
      let structured: Record<string, unknown> | undefined;
      try {
        const jsonMatch = body.response.match(/```json\s*([\s\S]*?)\s*```/) ||
                          body.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          structured = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
        }
      } catch { /* not JSON, that's fine */ }

      return {
        task_id: task.id,
        provider: 'local-llm',
        output: body.response,
        structured,
        confidence: 0.6, // Base confidence for local model, adjusted by accuracy tracker
        latency_ms: latency,
      };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`Ollama timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    }
  }
}
