/**
 * Design Iteration Pipeline — API route handlers.
 *
 * Thin HTTP adapter over {@link DesignTaskManager} and {@link DesignPipeline}.
 * All state mutations go through the manager (which emits events into the
 * shared event store so they survive restarts).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DesignTaskManager } from '../design-iteration/design-task-manager.js';
import type { DesignPipeline } from '../design-iteration/design-pipeline.js';
import type { DesignReview, DesignVariant, ParamConfig } from '../design-iteration/types.js';

export interface DesignRouteContext {
  designTaskManager?: DesignTaskManager;
  designPipeline?: DesignPipeline;
}

/**
 * Attempt to handle a design-task API request.
 * Returns `true` if the route matched (response written), `false` otherwise.
 */
export async function handleDesignRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DesignRouteContext,
): Promise<boolean> {
  const url = req.url ?? '';
  const method = req.method ?? '';

  // Only handle /api/design-tasks* paths. Don't claim other routes.
  if (!url.startsWith('/api/design-tasks')) return false;

  const tm = ctx.designTaskManager;
  if (!tm) {
    json(res, 503, { error: 'design task manager not ready' });
    return true;
  }

  // ── GET /api/design-tasks ──
  if (method === 'GET' && url === '/api/design-tasks') {
    json(res, 200, tm.list());
    return true;
  }

  // ── POST /api/design-tasks ──
  if (method === 'POST' && url === '/api/design-tasks') {
    const body = JSON.parse(await readBody(req)) as {
      title?: string;
      description?: string;
      baseline_path?: string;
      param_matrix?: ParamConfig[];
    };
    const task = tm.create({
      title: body.title ?? '',
      description: body.description ?? '',
      baseline_path: body.baseline_path ?? '',
      param_matrix: body.param_matrix ?? [],
    });
    json(res, 201, task);
    return true;
  }

  // ── GET /api/design-tasks/:id ──
  const detailMatch = url.match(/^\/api\/design-tasks\/([^/]+)$/);
  if (method === 'GET' && detailMatch) {
    const task = tm.get(detailMatch[1]);
    if (!task) return notFound(res);
    const variants = tm.getVariants(task.id, task.round);
    json(res, 200, { ...task, variants });
    return true;
  }

  // ── GET /api/design-tasks/:id/variants ──
  const variantsMatch = url.match(/^\/api\/design-tasks\/([^/]+)\/variants$/);
  if (method === 'GET' && variantsMatch) {
    const task = tm.get(variantsMatch[1]);
    if (!task) return notFound(res);
    json(res, 200, tm.getVariants(task.id, task.round));
    return true;
  }

  // ── POST /api/design-tasks/:id/variants ──
  if (method === 'POST' && variantsMatch) {
    const task = tm.get(variantsMatch[1]);
    if (!task) return notFound(res);
    const variant = JSON.parse(await readBody(req)) as Omit<DesignVariant, 'id' | 'task_id' | 'round'>;
    const created = tm.addVariant(task.id, variant);
    json(res, 201, created);
    return true;
  }

  // ── GET /api/design-tasks/:id/renders ──
  const rendersMatch = url.match(/^\/api\/design-tasks\/([^/]+)\/renders$/);
  if (method === 'GET' && rendersMatch) {
    const task = tm.get(rendersMatch[1]);
    if (!task) return notFound(res);
    json(res, 200, tm.getRenders(task.id));
    return true;
  }

  // ── POST /api/design-tasks/:id/review ──
  const reviewMatch = url.match(/^\/api\/design-tasks\/([^/]+)\/review$/);
  if (method === 'POST' && reviewMatch) {
    const task = tm.get(reviewMatch[1]);
    if (!task) return notFound(res);
    const body = JSON.parse(await readBody(req)) as DesignReview;
    const review: DesignReview = {
      ...body,
      task_id: task.id,
      round: task.round,
      exported_at: new Date().toISOString(),
    };

    if (ctx.designPipeline) {
      const outcome = ctx.designPipeline.completeReview(task.id, review);
      json(res, 200, { review, outcome });
    } else {
      tm.submitReview(task.id, review);
      json(res, 200, { review });
    }
    return true;
  }

  // ── GET /api/design-tasks/:id/history ──
  const historyMatch = url.match(/^\/api\/design-tasks\/([^/]+)\/history$/);
  if (method === 'GET' && historyMatch) {
    const task = tm.get(historyMatch[1]);
    if (!task) return notFound(res);
    const history: Array<{ round: number; review: DesignReview | undefined; variants: DesignVariant[] }> = [];
    for (let r = 1; r <= task.round; r++) {
      history.push({
        round: r,
        review: tm.getReview(task.id, r),
        variants: tm.getVariants(task.id, r),
      });
    }
    json(res, 200, history);
    return true;
  }

  // ── POST /api/design-tasks/:id/converge ──
  const convergeMatch = url.match(/^\/api\/design-tasks\/([^/]+)\/converge$/);
  if (method === 'POST' && convergeMatch) {
    const task = tm.get(convergeMatch[1]);
    if (!task) return notFound(res);
    const body = JSON.parse((await readBody(req)) || '{}') as { best_variant_key?: string };
    const bestKey = body.best_variant_key ?? tm.getVariants(task.id, task.round)[0]?.key ?? '';
    const updated = tm.converge(task.id, bestKey);
    json(res, 200, updated);
    return true;
  }

  // ── POST /api/design-tasks/:id/abort ──
  const abortMatch = url.match(/^\/api\/design-tasks\/([^/]+)\/abort$/);
  if (method === 'POST' && abortMatch) {
    const task = tm.get(abortMatch[1]);
    if (!task) return notFound(res);
    json(res, 200, tm.abort(task.id));
    return true;
  }

  // ── POST /api/design-tasks/:id/next-round ──
  const nextRoundMatch = url.match(/^\/api\/design-tasks\/([^/]+)\/next-round$/);
  if (method === 'POST' && nextRoundMatch) {
    const task = tm.get(nextRoundMatch[1]);
    if (!task) return notFound(res);
    if (task.status !== 'active' && task.status !== 'awaiting_review') {
      json(res, 400, { error: `task status '${task.status}' cannot advance` });
      return true;
    }
    json(res, 200, tm.nextRound(task.id));
    return true;
  }

  return false;
}

function notFound(res: ServerResponse): true {
  json(res, 404, { error: 'design task not found' });
  return true;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
