import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import type { Suggestion, SuggestionCategory, SuggestionStatus } from './types.js';

export class SuggestionEngine {
  private suggestions: Map<string, Suggestion> = new Map();
  readonly events = new EventEmitter();

  create(opts: {
    category: SuggestionCategory;
    summary: string;
    detail: string;
    evidence: string[];
    confidence: number;
    impact: Suggestion['impact'];
    region?: string;
  }): Suggestion {
    const suggestion: Suggestion = {
      id: ulid(),
      created_at: new Date().toISOString(),
      category: opts.category,
      summary: opts.summary,
      detail: opts.detail,
      evidence: opts.evidence,
      confidence: opts.confidence,
      impact: opts.impact,
      status: 'pending',
      region: opts.region,
    };

    this.suggestions.set(suggestion.id, suggestion);
    this.events.emit('suggestion_created', suggestion);
    return suggestion;
  }

  get(id: string): Suggestion | undefined {
    return this.suggestions.get(id);
  }

  list(status?: SuggestionStatus): Suggestion[] {
    const all = Array.from(this.suggestions.values());
    if (status) return all.filter((s) => s.status === status);
    return all;
  }

  updateStatus(id: string, status: SuggestionStatus): Suggestion {
    const s = this.suggestions.get(id);
    if (!s) throw new Error(`Suggestion ${id} not found`);
    s.status = status;
    this.events.emit('suggestion_status_changed', { suggestion: s, status });
    return s;
  }

  dismiss(id: string): Suggestion {
    return this.updateStatus(id, 'rejected');
  }

  acknowledge(id: string): Suggestion {
    return this.updateStatus(id, 'accepted');
  }
}
