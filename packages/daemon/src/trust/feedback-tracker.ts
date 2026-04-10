/**
 * Records negative feedback (rejected suggestions, discarded diffs)
 * for later analysis.
 */
export interface FeedbackEntry {
  id: string;
  timestamp: string;
  type: 'suggestion_rejected' | 'task_discarded';
  source_id: string;        // suggestion ID or task ID
  provider?: string;
  category?: string;
  user_action: string;
}

export class FeedbackTracker {
  private entries: FeedbackEntry[] = [];

  record(entry: Omit<FeedbackEntry, 'id' | 'timestamp'>): FeedbackEntry {
    const full: FeedbackEntry = {
      id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    return full;
  }

  list(): FeedbackEntry[] {
    return [...this.entries];
  }

  getBySource(sourceId: string): FeedbackEntry[] {
    return this.entries.filter((e) => e.source_id === sourceId);
  }
}
