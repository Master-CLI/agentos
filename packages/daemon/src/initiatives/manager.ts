import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import type { EmitEventFn, ProjectEvent } from '../events/types.js';
import type {
  Initiative,
  InitiativeNote,
  InitiativeNoteKind,
  InitiativeUpdate,
} from './types.js';

export interface InitiativeManagerOptions {
  projectId?: string;
  emit?: EmitEventFn;
}

export class InitiativeManager {
  private initiatives: Map<string, Initiative> = new Map();
  readonly events = new EventEmitter();
  private readonly emitFn?: EmitEventFn;
  private readonly projectId: string;

  constructor(opts: InitiativeManagerOptions = {}) {
    this.emitFn = opts.emit;
    this.projectId = opts.projectId ?? 'default';
  }

  create(opts: {
    title: string;
    motivation: string;
    completion_criteria: string;
    owner?: string;
    deadline?: string;
  }): Initiative {
    const initiative: Initiative = {
      id: ulid(),
      created_at: new Date().toISOString(),
      title: opts.title,
      motivation: opts.motivation,
      completion_criteria: opts.completion_criteria,
      owner: opts.owner,
      deadline: opts.deadline,
      status: 'active',
      notes: [],
    };

    this.initiatives.set(initiative.id, initiative);
    this.events.emit('initiative_created', initiative);
    this.emitFn?.({
      source: 'initiative-manager',
      type: 'initiative_created',
      payload: { initiative },
      metadata: { project_id: this.projectId },
    });
    return initiative;
  }

  get(id: string): Initiative | undefined {
    return this.initiatives.get(id);
  }

  list(status?: Initiative['status']): Initiative[] {
    const all = Array.from(this.initiatives.values());
    if (status) return all.filter((i) => i.status === status);
    return all;
  }

  update(id: string, patch: InitiativeUpdate): Initiative {
    const initiative = this.requireInitiative(id);
    if (patch.title !== undefined) initiative.title = patch.title;
    if (patch.motivation !== undefined) initiative.motivation = patch.motivation;
    if (patch.completion_criteria !== undefined) initiative.completion_criteria = patch.completion_criteria;
    if (patch.owner !== undefined) initiative.owner = patch.owner ?? undefined;
    if (patch.deadline !== undefined) initiative.deadline = patch.deadline ?? undefined;

    this.events.emit('initiative_updated', initiative);
    this.emitFn?.({
      source: 'initiative-manager',
      type: 'initiative_updated',
      payload: { id, patch },
      metadata: { project_id: this.projectId },
    });
    return initiative;
  }

  addNote(id: string, text: string, kind: InitiativeNoteKind = 'progress'): InitiativeNote {
    const initiative = this.requireInitiative(id);
    const note: InitiativeNote = {
      id: ulid(),
      at: new Date().toISOString(),
      text,
      kind,
    };
    initiative.notes.push(note);

    this.events.emit('initiative_note_added', { initiative_id: id, note });
    this.emitFn?.({
      source: 'initiative-manager',
      type: 'initiative_note_added',
      payload: { initiative_id: id, note },
      metadata: { project_id: this.projectId },
    });
    return note;
  }

  complete(id: string): Initiative {
    const initiative = this.requireInitiative(id);
    if (initiative.status === 'completed') return initiative;
    initiative.status = 'completed';
    initiative.completed_at = new Date().toISOString();

    this.events.emit('initiative_completed', initiative);
    this.emitFn?.({
      source: 'initiative-manager',
      type: 'initiative_completed',
      payload: { id, completed_at: initiative.completed_at },
      metadata: { project_id: this.projectId },
    });
    return initiative;
  }

  abandon(id: string, reason?: string): Initiative {
    const initiative = this.requireInitiative(id);
    if (initiative.status === 'abandoned') return initiative;
    initiative.status = 'abandoned';
    initiative.abandoned_at = new Date().toISOString();
    if (reason) {
      initiative.notes.push({
        id: ulid(),
        at: initiative.abandoned_at,
        text: reason,
        kind: 'decision',
      });
    }

    this.events.emit('initiative_abandoned', initiative);
    this.emitFn?.({
      source: 'initiative-manager',
      type: 'initiative_abandoned',
      payload: { id, abandoned_at: initiative.abandoned_at, reason },
      metadata: { project_id: this.projectId },
    });
    return initiative;
  }

  /** Rebuild in-memory state from a replayed event stream. */
  replay(events: ProjectEvent[]): void {
    this.initiatives.clear();
    for (const event of events) {
      this.applyReplayEvent(event);
    }
  }

  private applyReplayEvent(event: ProjectEvent): void {
    const { type, payload } = event;
    if (type === 'initiative_created') {
      const i = payload.initiative as Initiative | undefined;
      if (i?.id) {
        const cloned = structuredClone(i);
        if (!cloned.notes) cloned.notes = [];
        this.initiatives.set(i.id, cloned);
      }
    } else if (type === 'initiative_updated') {
      const id = payload.id as string | undefined;
      const patch = payload.patch as InitiativeUpdate | undefined;
      if (id && patch) {
        const existing = this.initiatives.get(id);
        if (existing) {
          if (patch.title !== undefined) existing.title = patch.title;
          if (patch.motivation !== undefined) existing.motivation = patch.motivation;
          if (patch.completion_criteria !== undefined) existing.completion_criteria = patch.completion_criteria;
          if (patch.owner !== undefined) existing.owner = patch.owner ?? undefined;
          if (patch.deadline !== undefined) existing.deadline = patch.deadline ?? undefined;
        }
      }
    } else if (type === 'initiative_note_added') {
      const id = payload.initiative_id as string | undefined;
      const note = payload.note as InitiativeNote | undefined;
      if (id && note) {
        const existing = this.initiatives.get(id);
        if (existing) existing.notes.push(structuredClone(note));
      }
    } else if (type === 'initiative_completed') {
      const id = payload.id as string | undefined;
      const completedAt = payload.completed_at as string | undefined;
      if (id) {
        const existing = this.initiatives.get(id);
        if (existing) {
          existing.status = 'completed';
          existing.completed_at = completedAt;
        }
      }
    } else if (type === 'initiative_abandoned') {
      const id = payload.id as string | undefined;
      const abandonedAt = payload.abandoned_at as string | undefined;
      if (id) {
        const existing = this.initiatives.get(id);
        if (existing) {
          existing.status = 'abandoned';
          existing.abandoned_at = abandonedAt;
        }
      }
    }
  }

  private requireInitiative(id: string): Initiative {
    const initiative = this.initiatives.get(id);
    if (!initiative) throw new Error(`Initiative ${id} not found`);
    return initiative;
  }
}
