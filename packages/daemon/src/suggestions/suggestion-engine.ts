import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import type { Suggestion, SuggestionCategory, SuggestionStatus } from './types.js';
import type { EmitEventFn, ProjectEvent } from '../events/types.js';

export interface SuggestionEngineOptions {
  projectId?: string;
  /** If set, every state change is persisted via the unified event pipeline. */
  emit?: EmitEventFn;
}

export class SuggestionEngine {
  private suggestions: Map<string, Suggestion> = new Map();
  readonly events = new EventEmitter();
  private readonly emit?: EmitEventFn;
  private readonly projectId: string;

  constructor(opts: SuggestionEngineOptions = {}) {
    this.emit = opts.emit;
    this.projectId = opts.projectId ?? 'default';
  }

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
    this.emit?.({
      source: 'suggestion-engine',
      type: 'suggestion_created',
      payload: { suggestion },
      metadata: { project_id: this.projectId },
    });
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
    const prev = s.status;
    s.status = status;
    this.events.emit('suggestion_status_changed', { suggestion: s, status, prev });
    this.emit?.({
      source: 'suggestion-engine',
      type: 'suggestion_status_changed',
      payload: { id, status, prev_status: prev },
      metadata: { project_id: this.projectId },
    });
    return s;
  }

  dismiss(id: string): Suggestion {
    return this.updateStatus(id, 'rejected');
  }

  acknowledge(id: string): Suggestion {
    return this.updateStatus(id, 'accepted');
  }

  /**
   * Rebuild in-memory state from a replayed event stream (cold start).
   * Non-matching event types are ignored.
   */
  replay(events: ProjectEvent[]): void {
    this.suggestions.clear();
    for (const event of events) {
      if (event.type === 'suggestion_created') {
        const s = event.payload.suggestion as Suggestion | undefined;
        if (s?.id) this.suggestions.set(s.id, { ...s });
      } else if (event.type === 'suggestion_status_changed') {
        const id = event.payload.id as string | undefined;
        const status = event.payload.status as SuggestionStatus | undefined;
        if (id && status) {
          const s = this.suggestions.get(id);
          if (s) s.status = status;
        }
      }
    }
  }
}
