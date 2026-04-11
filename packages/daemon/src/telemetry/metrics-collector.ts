import type { ProviderName } from '../reasoning/types.js';

export interface SystemMetrics {
  dialog_count: number;
  avg_response_latency_ms: number;
  provider_usage: Record<string, number>;
  suggestions_total: number;
  suggestions_converted: number;
}

export class MetricsCollector {
  private dialogCount = 0;
  private responseTimes: number[] = [];
  private providerCalls: Map<string, number> = new Map();
  private suggestionStats = { total: 0, converted: 0 };

  recordDialog(latencyMs: number): void {
    this.dialogCount++;
    this.responseTimes.push(latencyMs);
  }

  recordProviderCall(provider: ProviderName | string): void {
    this.providerCalls.set(provider, (this.providerCalls.get(provider) ?? 0) + 1);
  }

  recordSuggestion(converted: boolean): void {
    this.suggestionStats.total++;
    if (converted) this.suggestionStats.converted++;
  }

  getMetrics(): SystemMetrics {
    const avgLatency = this.responseTimes.length > 0
      ? this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length
      : 0;

    return {
      dialog_count: this.dialogCount,
      avg_response_latency_ms: Math.round(avgLatency),
      provider_usage: Object.fromEntries(this.providerCalls),
      suggestions_total: this.suggestionStats.total,
      suggestions_converted: this.suggestionStats.converted,
    };
  }
}
