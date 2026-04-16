import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import type { CodeTask, TaskStatus, TaskOrigin, ChangeLevel, TaskPipeline } from './types.js';
import type { EmitEventFn, ProjectEvent } from '../events/types.js';

function emptyPipeline(): TaskPipeline {
  return {
    implementation: { provider: null, diff: [], started_at: null, completed_at: null },
    testing: { provider: null, test_files: [], run_result: null },
    reviews: [],
    consensus: 'pending',
    fix_attempts: 0,
  };
}

export interface TaskManagerOptions {
  projectId?: string;
  emit?: EmitEventFn;
}

export class TaskManager {
  private tasks: Map<string, CodeTask> = new Map();
  readonly events = new EventEmitter();
  private readonly emit?: EmitEventFn;
  private readonly projectId: string;

  constructor(opts: TaskManagerOptions = {}) {
    this.emit = opts.emit;
    this.projectId = opts.projectId ?? 'default';
  }

  create(opts: {
    prompt: string;
    origin: TaskOrigin;
    projectId: string;
    relatedModules?: string[];
    changeLevel?: ChangeLevel;
    sourceSuggestionId?: string;
    initiativeId?: string;
  }): CodeTask {
    const task: CodeTask = {
      id: ulid(),
      created_at: new Date().toISOString(),
      origin: opts.origin,
      source_suggestion_id: opts.sourceSuggestionId,
      prompt: opts.prompt,
      context: {
        related_modules: opts.relatedModules ?? [],
        project_id: opts.projectId,
      },
      change_level: opts.changeLevel ?? 'standard',
      pipeline: emptyPipeline(),
      status: 'queued',
      initiative_id: opts.initiativeId,
    };

    this.tasks.set(task.id, task);
    this.events.emit('task_created', task);
    this.emit?.({
      source: 'task-manager',
      type: 'task_created',
      payload: { task },
      metadata: { project_id: opts.projectId },
    });
    return task;
  }

  get(id: string): CodeTask | undefined {
    return this.tasks.get(id);
  }

  list(): CodeTask[] {
    return Array.from(this.tasks.values());
  }

  updateStatus(id: string, status: TaskStatus): CodeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    const prev = task.status;
    task.status = status;
    this.events.emit('task_status_changed', { task, status });
    this.emit?.({
      source: 'task-manager',
      type: 'task_status_changed',
      payload: { id, status, prev_status: prev },
      metadata: { project_id: task.context.project_id },
    });
    return task;
  }

  updatePipeline(id: string, updater: (pipeline: TaskPipeline) => void): CodeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    updater(task.pipeline);
    this.events.emit('task_pipeline_updated', task);
    this.emit?.({
      source: 'task-manager',
      type: 'task_pipeline_updated',
      payload: { id, pipeline: task.pipeline, change_level: task.change_level },
      metadata: { project_id: task.context.project_id },
    });
    return task;
  }

  /**
   * Change a task's classified change level (e.g., after implement-stage reclassification).
   * Emits `task_change_level_updated` so replay reconstructs it.
   */
  updateChangeLevel(id: string, level: ChangeLevel): CodeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    task.change_level = level;
    this.emit?.({
      source: 'task-manager',
      type: 'task_change_level_updated',
      payload: { id, change_level: level },
      metadata: { project_id: task.context.project_id },
    });
    return task;
  }

  replay(events: ProjectEvent[]): void {
    this.tasks.clear();
    for (const event of events) {
      if (event.type === 'task_created') {
        const t = event.payload.task as CodeTask | undefined;
        if (t?.id) this.tasks.set(t.id, structuredClone(t));
      } else if (event.type === 'task_status_changed') {
        const id = event.payload.id as string | undefined;
        const status = event.payload.status as TaskStatus | undefined;
        if (id && status) {
          const t = this.tasks.get(id);
          if (t) t.status = status;
        }
      } else if (event.type === 'task_pipeline_updated') {
        const id = event.payload.id as string | undefined;
        const pipeline = event.payload.pipeline as TaskPipeline | undefined;
        if (id && pipeline) {
          const t = this.tasks.get(id);
          if (t) t.pipeline = structuredClone(pipeline);
        }
      } else if (event.type === 'task_change_level_updated') {
        const id = event.payload.id as string | undefined;
        const level = event.payload.change_level as ChangeLevel | undefined;
        if (id && level) {
          const t = this.tasks.get(id);
          if (t) t.change_level = level;
        }
      }
    }
  }
}
