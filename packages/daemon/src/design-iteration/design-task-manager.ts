import { ulid } from 'ulid';
import { EventEmitter } from 'node:events';
import type {
  DesignTask,
  DesignVariant,
  RenderEntry,
  DesignReview,
  DesignConstraint,
  ParamConfig,
} from './types.js';
import type { EmitEventFn, ProjectEvent } from '../events/types.js';

export interface DesignTaskManagerOptions {
  projectId?: string;
  emit?: EmitEventFn;
}

export class DesignTaskManager {
  private tasks: Map<string, DesignTask> = new Map();
  private variants: Map<string, DesignVariant[]> = new Map();   // taskId → variants
  private renders: Map<string, RenderEntry[]> = new Map();      // taskId → renders
  private reviews: Map<string, DesignReview[]> = new Map();     // taskId → reviews per round
  readonly events = new EventEmitter();
  private readonly emitFn?: EmitEventFn;
  private readonly projectId: string;

  constructor(opts: DesignTaskManagerOptions = {}) {
    this.emitFn = opts.emit;
    this.projectId = opts.projectId ?? 'default';
  }

  create(opts: {
    title: string;
    description: string;
    baseline_path: string;
    param_matrix: ParamConfig[];
    constraints?: DesignConstraint[];
  }): DesignTask {
    const task: DesignTask = {
      id: ulid(),
      created_at: new Date().toISOString(),
      title: opts.title,
      description: opts.description,
      baseline_path: opts.baseline_path,
      param_matrix: opts.param_matrix,
      round: 1,
      status: 'active',
      constraints: opts.constraints ?? [],
    };

    this.tasks.set(task.id, task);
    this.variants.set(task.id, []);
    this.renders.set(task.id, []);
    this.reviews.set(task.id, []);
    this.events.emit('design_task_created', task);
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_task_created',
      payload: { task },
      metadata: { project_id: this.projectId },
    });
    return task;
  }

  get(id: string): DesignTask | undefined {
    return this.tasks.get(id);
  }

  list(): DesignTask[] {
    return Array.from(this.tasks.values());
  }

  // --- Variants ---

  addVariant(taskId: string, variant: Omit<DesignVariant, 'id' | 'task_id' | 'round'>): DesignVariant {
    const task = this.requireTask(taskId);
    const full: DesignVariant = {
      ...variant,
      id: ulid(),
      task_id: taskId,
      round: task.round,
    };
    this.variants.get(taskId)!.push(full);
    this.events.emit('design_variant_added', { taskId, variant: full });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_variant_added',
      payload: { task_id: taskId, variant: full },
      metadata: { project_id: this.projectId },
    });
    return full;
  }

  getVariants(taskId: string, round?: number): DesignVariant[] {
    const all = this.variants.get(taskId) ?? [];
    if (round !== undefined) return all.filter((v) => v.round === round);
    return all;
  }

  // --- Renders ---

  addRenders(taskId: string, entries: RenderEntry[]): void {
    this.requireTask(taskId);
    const list = this.renders.get(taskId)!;
    list.push(...entries);
    this.events.emit('design_renders_complete', { taskId, count: entries.length });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_renders_complete',
      payload: { task_id: taskId, entries },
      metadata: { project_id: this.projectId },
    });
  }

  getRenders(taskId: string, round?: number): RenderEntry[] {
    const all = this.renders.get(taskId) ?? [];
    if (round === undefined) return all;
    const variantIds = new Set(
      this.getVariants(taskId, round).map((v) => v.id),
    );
    return all.filter((r) => variantIds.has(r.variant_id));
  }

  // --- AI Scores ---

  setAIScores(
    taskId: string,
    variantKey: string,
    scores: Record<string, number>,
    comments: Record<string, string>,
  ): void {
    const task = this.requireTask(taskId);
    const variant = this.getVariants(taskId, task.round).find((v) => v.key === variantKey);
    if (!variant) throw new Error(`Variant '${variantKey}' not found in round ${task.round}`);
    variant.ai_scores = scores;
    variant.ai_comments = comments;
    this.events.emit('design_ai_scored', { taskId, variantKey });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_ai_scored',
      payload: { task_id: taskId, variant_id: variant.id, variant_key: variantKey, round: task.round, scores, comments },
      metadata: { project_id: this.projectId },
    });
  }

  // --- Human Review ---

  submitReview(taskId: string, review: DesignReview): void {
    this.requireTask(taskId);
    const list = this.reviews.get(taskId)!;
    const idx = list.findIndex((r) => r.round === review.round);
    if (idx >= 0) list[idx] = review;
    else list.push(review);
    this.events.emit('design_human_reviewed', { taskId, round: review.round });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_human_reviewed',
      payload: { task_id: taskId, review },
      metadata: { project_id: this.projectId },
    });
  }

  getReview(taskId: string, round?: number): DesignReview | undefined {
    const all = this.reviews.get(taskId) ?? [];
    if (round !== undefined) return all.find((r) => r.round === round);
    return all[all.length - 1];
  }

  // --- Constraints ---

  addConstraint(taskId: string, constraint: DesignConstraint): void {
    const task = this.requireTask(taskId);
    task.constraints.push(constraint);
    this.events.emit('design_constraint_learned', { taskId, constraint });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_constraint_learned',
      payload: { task_id: taskId, constraint },
      metadata: { project_id: this.projectId },
    });
  }

  // --- Status transitions ---

  markAwaitingReview(taskId: string): void {
    const task = this.requireTask(taskId);
    task.status = 'awaiting_review';
    this.events.emit('design_awaiting_review', { taskId, round: task.round });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_awaiting_review',
      payload: { task_id: taskId, round: task.round },
      metadata: { project_id: this.projectId },
    });
  }

  nextRound(taskId: string): DesignTask {
    const task = this.requireTask(taskId);
    task.round += 1;
    task.status = 'active';
    this.events.emit('design_round_started', { taskId, round: task.round });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_round_started',
      payload: { task_id: taskId, round: task.round },
      metadata: { project_id: this.projectId },
    });
    return task;
  }

  converge(taskId: string, bestVariantKey: string): DesignTask {
    const task = this.requireTask(taskId);
    task.status = 'converged';
    this.events.emit('design_round_converged', { taskId, bestVariantKey });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_round_converged',
      payload: { task_id: taskId, round: task.round, best_variant_key: bestVariantKey },
      metadata: { project_id: this.projectId },
    });
    this.events.emit('design_task_completed', { taskId });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_task_completed',
      payload: { task_id: taskId, converged: true },
      metadata: { project_id: this.projectId },
    });
    return task;
  }

  abort(taskId: string): DesignTask {
    const task = this.requireTask(taskId);
    task.status = 'aborted';
    this.events.emit('design_task_completed', { taskId, aborted: true });
    this.emitFn?.({
      source: 'design-iteration',
      type: 'design_task_completed',
      payload: { task_id: taskId, aborted: true },
      metadata: { project_id: this.projectId },
    });
    return task;
  }

  // --- Replay ---

  replay(events: ProjectEvent[]): void {
    this.tasks.clear();
    this.variants.clear();
    this.renders.clear();
    this.reviews.clear();
    for (const event of events) {
      this.applyReplayEvent(event);
    }
  }

  private applyReplayEvent(event: ProjectEvent): void {
    const { type, payload } = event;
    if (type === 'design_task_created') {
      const t = payload.task as DesignTask | undefined;
      if (t?.id) {
        this.tasks.set(t.id, structuredClone(t));
        this.variants.set(t.id, []);
        this.renders.set(t.id, []);
        this.reviews.set(t.id, []);
      }
    } else if (type === 'design_variant_added') {
      const taskId = payload.task_id as string | undefined;
      const variant = payload.variant as DesignVariant | undefined;
      if (taskId && variant && this.variants.has(taskId)) {
        this.variants.get(taskId)!.push(structuredClone(variant));
      }
    } else if (type === 'design_renders_complete') {
      const taskId = payload.task_id as string | undefined;
      const entries = payload.entries as RenderEntry[] | undefined;
      if (taskId && Array.isArray(entries) && this.renders.has(taskId)) {
        this.renders.get(taskId)!.push(...entries.map((e) => structuredClone(e)));
      }
    } else if (type === 'design_ai_scored') {
      const taskId = payload.task_id as string | undefined;
      const variantId = payload.variant_id as string | undefined;
      const scores = payload.scores as Record<string, number> | undefined;
      const comments = payload.comments as Record<string, string> | undefined;
      if (taskId && variantId && scores && comments) {
        const list = this.variants.get(taskId);
        const variant = list?.find((v) => v.id === variantId);
        if (variant) {
          variant.ai_scores = { ...scores };
          variant.ai_comments = { ...comments };
        }
      }
    } else if (type === 'design_human_reviewed') {
      const taskId = payload.task_id as string | undefined;
      const review = payload.review as DesignReview | undefined;
      if (taskId && review && this.reviews.has(taskId)) {
        const list = this.reviews.get(taskId)!;
        const idx = list.findIndex((r) => r.round === review.round);
        if (idx >= 0) list[idx] = structuredClone(review);
        else list.push(structuredClone(review));
      }
    } else if (type === 'design_constraint_learned') {
      const taskId = payload.task_id as string | undefined;
      const constraint = payload.constraint as DesignConstraint | undefined;
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (task && constraint) {
        task.constraints.push(structuredClone(constraint));
      }
    } else if (type === 'design_awaiting_review') {
      const taskId = payload.task_id as string | undefined;
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (task) task.status = 'awaiting_review';
    } else if (type === 'design_round_started') {
      const taskId = payload.task_id as string | undefined;
      const round = payload.round as number | undefined;
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (task && typeof round === 'number') {
        task.round = round;
        task.status = 'active';
      }
    } else if (type === 'design_round_converged') {
      const taskId = payload.task_id as string | undefined;
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (task) task.status = 'converged';
    } else if (type === 'design_task_completed') {
      const taskId = payload.task_id as string | undefined;
      const aborted = Boolean(payload.aborted);
      const task = taskId ? this.tasks.get(taskId) : undefined;
      if (task && aborted) task.status = 'aborted';
    }
  }

  // --- Internal helpers ---

  private requireTask(id: string): DesignTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`DesignTask ${id} not found`);
    return task;
  }
}
