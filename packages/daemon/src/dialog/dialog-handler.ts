import type { ReasoningRouter } from '../reasoning/router.js';
import type { SnapshotEngine } from '../state/snapshot-engine.js';
import type { EventStore } from '../events/event-store.js';
import type { SuggestionEngine } from '../suggestions/suggestion-engine.js';
import type { OutputCallback } from '../reasoning/types.js';

export interface DialogMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface DialogContext {
  snapshot: ReturnType<SnapshotEngine['getSnapshot']>;
  recentEvents: Array<{ type: string; timestamp: string; payload: Record<string, unknown> }>;
  pendingSuggestions: number;
}

export class DialogHandler {
  private history: DialogMessage[] = [];
  private idCounter = 0;

  constructor(
    private router: ReasoningRouter,
    private snapshotEngine: SnapshotEngine,
    private eventStore: EventStore,
    private suggestionEngine: SuggestionEngine,
  ) {}

  /**
   * Answer a project question using accumulated context.
   */
  async ask(question: string, onOutput?: OutputCallback): Promise<DialogMessage> {
    // Record user message
    const userMsg: DialogMessage = {
      id: String(++this.idCounter),
      role: 'user',
      content: question,
      timestamp: new Date().toISOString(),
    };
    this.history.push(userMsg);

    // Build project context
    const ctx = this.buildContext();
    const prompt = this.buildPrompt(question, ctx);

    // Try CLI agent first for deep questions, fall back to local LLM
    let answer: string;
    try {
      const result = await this.router.execute({
        type: 'interpret',
        prompt,
        onOutput,
      });
      answer = result.output;
    } catch {
      // All providers unavailable — return context summary as fallback
      answer = this.fallbackAnswer(question, ctx);
    }

    const assistantMsg: DialogMessage = {
      id: String(++this.idCounter),
      role: 'assistant',
      content: answer,
      timestamp: new Date().toISOString(),
    };
    this.history.push(assistantMsg);

    // Keep history bounded
    if (this.history.length > 100) {
      this.history = this.history.slice(-100);
    }

    return assistantMsg;
  }

  getHistory(): DialogMessage[] {
    return [...this.history];
  }

  getContext(): DialogContext {
    return this.buildContext();
  }

  private buildContext(): DialogContext {
    const snapshot = this.snapshotEngine.getSnapshot();

    // Recent events (last 50)
    const allEvents = this.eventStore.query({ limit: 50 });
    const recentEvents = allEvents.map((e) => ({
      type: e.type,
      timestamp: e.timestamp,
      payload: e.payload,
    }));

    const pendingSuggestions = this.suggestionEngine.list('pending').length;

    return { snapshot, recentEvents, pendingSuggestions };
  }

  private buildPrompt(question: string, ctx: DialogContext): string {
    const snap = ctx.snapshot;
    const recentSummary = ctx.recentEvents.slice(-20).map((e) => {
      const detail = e.payload.path ?? e.payload.message ?? e.payload.branch ?? '';
      return `  [${e.type}] ${detail}`;
    }).join('\n');

    return (
      `You are AgentOS, an intelligent project coordination assistant. ` +
      `You observe the project continuously and answer questions based on what you see.\n` +
      `Answer concisely in the same language as the question.\n` +
      `Do NOT offer to write code or modify files — that is the user's job.\n` +
      `Focus on analysis, risks, patterns, and suggestions.\n\n` +
      `## Project State\n` +
      `- Total events observed: ${snap.metrics.total_events}\n` +
      `- Events in last hour: ${snap.metrics.events_last_hour}\n` +
      `- Active files tracked: ${snap.metrics.active_files}\n` +
      `- Recent commits: ${snap.recent_commits.length}\n` +
      `- Pending suggestions: ${ctx.pendingSuggestions}\n\n` +
      `## Recent Activity\n${recentSummary || '(no recent events)'}\n\n` +
      (snap.recent_commits.length > 0
        ? `## Recent Commits\n${snap.recent_commits.slice(0, 5).map((c) => `  ${c.hash.slice(0, 7)} ${c.message}`).join('\n')}\n\n`
        : '') +
      `## User Question\n${question}`
    );
  }

  private fallbackAnswer(question: string, ctx: DialogContext): string {
    const snap = ctx.snapshot;
    return (
      `[No LLM available — showing raw project state]\n\n` +
      `Events observed: ${snap.metrics.total_events}\n` +
      `Events last hour: ${snap.metrics.events_last_hour}\n` +
      `Active files: ${snap.metrics.active_files}\n` +
      `Recent commits: ${snap.recent_commits.length}\n` +
      `Pending suggestions: ${ctx.pendingSuggestions}`
    );
  }
}
