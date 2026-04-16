import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import type { EventStore } from '../events/event-store.js';
import type { EmitEventFn, ProjectEvent } from '../events/types.js';
import type { InitiativeManager } from '../initiatives/manager.js';
import type {
  RetrospectiveReport,
  RetrospectiveSuggestionBreakdown,
  RetrospectiveTaskBreakdown,
  RetrospectiveInitiativeBreakdown,
  RetrospectiveRegion,
  StaleInitiative,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetrospectiveEngineOptions {
  projectId?: string;
  eventStore: EventStore;
  initiativeManager?: InitiativeManager;
  emit?: EmitEventFn;
  /** Age in days after which an active Initiative with no recent note is 'stale'. Default 14. */
  staleDays?: number;
}

export interface GenerateOptions {
  windowMs?: number;
  windowStart?: string;
  windowEnd?: string;
}

/**
 * Generates and stores {@link RetrospectiveReport}s.
 *
 * Generation is deterministic given the event log, so replay just
 * rematerializes the list of historical reports from `retrospective_generated`
 * events — it does NOT re-run aggregation.
 */
export class RetrospectiveEngine {
  private reports: Map<string, RetrospectiveReport> = new Map();
  readonly events = new EventEmitter();
  private readonly eventStore: EventStore;
  private readonly initiativeManager?: InitiativeManager;
  private readonly emitFn?: EmitEventFn;
  private readonly projectId: string;
  private readonly staleDays: number;

  constructor(opts: RetrospectiveEngineOptions) {
    this.eventStore = opts.eventStore;
    this.initiativeManager = opts.initiativeManager;
    this.emitFn = opts.emit;
    this.projectId = opts.projectId ?? 'default';
    this.staleDays = opts.staleDays ?? 14;
  }

  list(): RetrospectiveReport[] {
    return Array.from(this.reports.values())
      .sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  }

  get(id: string): RetrospectiveReport | undefined {
    return this.reports.get(id);
  }

  /**
   * Read the event log over the given window, aggregate, create a report,
   * persist it as a `retrospective_generated` event, and return it.
   */
  generate(opts: GenerateOptions = {}): RetrospectiveReport {
    const end = opts.windowEnd ?? new Date().toISOString();
    const windowMs = opts.windowMs ?? 7 * DAY_MS;
    const start = opts.windowStart ?? new Date(Date.parse(end) - windowMs).toISOString();

    const events = this.eventStore.query({ from: start, to: end, projectId: this.projectId });

    const report: RetrospectiveReport = {
      id: ulid(),
      generated_at: new Date().toISOString(),
      window_start: start,
      window_end: end,
      total_events: events.length,
      event_counts: countByType(events),
      suggestions: aggregateSuggestions(events),
      tasks: aggregateTasks(events),
      initiatives: this.aggregateInitiatives(events, start, end),
      top_regions: topRegions(events, 10),
      commit_count: events.filter((e) => e.type === 'commit_pushed').length,
    };

    this.reports.set(report.id, report);
    this.events.emit('retrospective_generated', report);
    this.emitFn?.({
      source: 'retrospective-engine',
      type: 'retrospective_generated',
      payload: { report },
      metadata: { project_id: this.projectId },
    });
    return report;
  }

  /** Rebuild the report list from the event log (does not re-aggregate). */
  replay(events: ProjectEvent[]): void {
    this.reports.clear();
    for (const event of events) {
      if (event.type !== 'retrospective_generated') continue;
      const report = event.payload.report as RetrospectiveReport | undefined;
      if (report?.id) {
        this.reports.set(report.id, structuredClone(report));
      }
    }
  }

  private aggregateInitiatives(
    events: ProjectEvent[],
    start: string,
    end: string,
  ): RetrospectiveInitiativeBreakdown {
    const completedInWindow = events.filter((e) => e.type === 'initiative_completed').length;
    const abandonedInWindow = events.filter((e) => e.type === 'initiative_abandoned').length;

    let active = 0;
    const stale: StaleInitiative[] = [];
    const endMs = Date.parse(end);

    for (const initiative of this.initiativeManager?.list() ?? []) {
      if (initiative.status !== 'active') continue;
      active++;

      const lastNote = initiative.notes[initiative.notes.length - 1];
      const lastActivityAt = lastNote?.at ?? initiative.created_at;
      const ageDays = (endMs - Date.parse(lastActivityAt)) / DAY_MS;
      if (ageDays > this.staleDays) {
        stale.push({
          id: initiative.id,
          title: initiative.title,
          age_days: Math.round(ageDays * 10) / 10,
          last_note_at: lastNote?.at,
        });
      }
    }
    // Silence unused binding — `start` is still part of the window contract
    // even though the stale computation uses window_end.
    void start;

    stale.sort((a, b) => b.age_days - a.age_days);

    return {
      active,
      completed_this_window: completedInWindow,
      abandoned_this_window: abandonedInWindow,
      stale,
    };
  }
}

function countByType(events: ProjectEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    out[e.type] = (out[e.type] ?? 0) + 1;
  }
  return out;
}

function aggregateSuggestions(events: ProjectEvent[]): RetrospectiveSuggestionBreakdown {
  const out: RetrospectiveSuggestionBreakdown = {
    created: 0,
    accepted: 0,
    rejected: 0,
    by_category: {},
  };
  for (const e of events) {
    if (e.type === 'suggestion_created') {
      out.created++;
      const suggestion = e.payload.suggestion as { category?: string } | undefined;
      const category = suggestion?.category ?? 'unknown';
      out.by_category[category] = (out.by_category[category] ?? 0) + 1;
    } else if (e.type === 'suggestion_status_changed') {
      const status = e.payload.status as string | undefined;
      if (status === 'accepted' || status === 'converted') out.accepted++;
      else if (status === 'rejected') out.rejected++;
    }
  }
  return out;
}

function aggregateTasks(events: ProjectEvent[]): RetrospectiveTaskBreakdown {
  const out: RetrospectiveTaskBreakdown = { created: 0, completed: 0, awaiting_user: 0 };
  const terminalStatusById: Record<string, string> = {};
  for (const e of events) {
    if (e.type === 'task_created') {
      out.created++;
    } else if (e.type === 'task_status_changed') {
      const id = e.payload.id as string | undefined;
      const status = e.payload.status as string | undefined;
      if (id && status) terminalStatusById[id] = status;
    }
  }
  for (const status of Object.values(terminalStatusById)) {
    if (status === 'completed') out.completed++;
    else if (status === 'awaiting_user') out.awaiting_user++;
  }
  return out;
}

function topRegions(events: ProjectEvent[], limit: number): RetrospectiveRegion[] {
  const counts: Record<string, number> = {};
  for (const e of events) {
    if (e.type !== 'file_modified' && e.type !== 'file_created') continue;
    const pathValue = e.payload.path;
    if (typeof pathValue !== 'string') continue;
    counts[pathValue] = (counts[pathValue] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, count]) => ({ path, count }));
}
