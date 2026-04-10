import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import type { CodeTask, TaskStatus, TaskOrigin, ChangeLevel, TaskPipeline } from './types.js';

function emptyPipeline(): TaskPipeline {
  return {
    implementation: { provider: null, diff: [], started_at: null, completed_at: null },
    testing: { provider: null, test_files: [], run_result: null },
    reviews: [],
    consensus: 'pending',
    fix_attempts: 0,
  };
}

export class TaskManager {
  private tasks: Map<string, CodeTask> = new Map();
  readonly events = new EventEmitter();

  create(opts: {
    prompt: string;
    origin: TaskOrigin;
    projectId: string;
    relatedModules?: string[];
    changeLevel?: ChangeLevel;
    sourceSuggestionId?: string;
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
    };

    this.tasks.set(task.id, task);
    this.events.emit('task_created', task);
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
    task.status = status;
    this.events.emit('task_status_changed', { task, status });
    return task;
  }

  updatePipeline(id: string, updater: (pipeline: TaskPipeline) => void): CodeTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task ${id} not found`);
    updater(task.pipeline);
    this.events.emit('task_pipeline_updated', task);
    return task;
  }
}
