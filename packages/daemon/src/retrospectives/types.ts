/**
 * Retrospective — a periodic aggregated summary of project activity.
 *
 * Unlike reactive Suggestions, retrospectives are *scheduled reflection*:
 * every N days the engine scans the event log over the window and produces
 * a structured report that surfaces trends the human would otherwise miss
 * (e.g. which suggestions types are being rejected the most, which
 * initiatives have stalled, which files are churning hardest).
 */

export interface RetrospectiveSuggestionBreakdown {
  created: number;
  accepted: number;
  rejected: number;
  by_category: Record<string, number>;
}

export interface RetrospectiveTaskBreakdown {
  created: number;
  completed: number;
  awaiting_user: number;
}

export interface StaleInitiative {
  id: string;
  title: string;
  age_days: number;
  last_note_at?: string;
}

export interface RetrospectiveInitiativeBreakdown {
  active: number;
  completed_this_window: number;
  abandoned_this_window: number;
  stale: StaleInitiative[];
}

export interface RetrospectiveRegion {
  path: string;
  count: number;
}

export interface RetrospectiveReport {
  id: string;
  generated_at: string;
  window_start: string;
  window_end: string;
  total_events: number;
  event_counts: Record<string, number>;
  suggestions: RetrospectiveSuggestionBreakdown;
  tasks: RetrospectiveTaskBreakdown;
  initiatives: RetrospectiveInitiativeBreakdown;
  top_regions: RetrospectiveRegion[];
  commit_count: number;
  /** Optional freeform narrative (populated by LLM, blank if no provider). */
  narrative?: string;
}
