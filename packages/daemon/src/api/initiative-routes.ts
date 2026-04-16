/**
 * Initiative — API route handlers.
 *
 * Thin HTTP adapter over {@link InitiativeManager}. All mutations go through
 * the manager so they land in the shared event store and survive restarts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InitiativeManager } from '../initiatives/manager.js';
import type { InitiativeUpdate, InitiativeNoteKind } from '../initiatives/types.js';

export interface InitiativeRouteContext {
  initiativeManager?: InitiativeManager;
}

export async function handleInitiativeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: InitiativeRouteContext,
): Promise<boolean> {
  const url = req.url ?? '';
  const method = req.method ?? '';

  if (!url.startsWith('/api/initiatives')) return false;

  const tm = ctx.initiativeManager;
  if (!tm) {
    json(res, 503, { error: 'initiative manager not ready' });
    return true;
  }

  // ── GET /api/initiatives ──
  if (method === 'GET' && (url === '/api/initiatives' || url.startsWith('/api/initiatives?'))) {
    const params = new URL(url, 'http://localhost').searchParams;
    const status = params.get('status');
    const list = status && ['active', 'completed', 'abandoned'].includes(status)
      ? tm.list(status as 'active' | 'completed' | 'abandoned')
      : tm.list();
    json(res, 200, list);
    return true;
  }

  // ── POST /api/initiatives ──
  if (method === 'POST' && url === '/api/initiatives') {
    const body = JSON.parse(await readBody(req)) as {
      title?: string;
      motivation?: string;
      completion_criteria?: string;
      owner?: string;
      deadline?: string;
    };
    if (!body.title || !body.motivation || !body.completion_criteria) {
      json(res, 400, { error: 'title, motivation, completion_criteria are required' });
      return true;
    }
    const initiative = tm.create({
      title: body.title,
      motivation: body.motivation,
      completion_criteria: body.completion_criteria,
      owner: body.owner,
      deadline: body.deadline,
    });
    json(res, 201, initiative);
    return true;
  }

  // ── GET /api/initiatives/:id ──
  const detailMatch = url.match(/^\/api\/initiatives\/([^/]+)$/);
  if (method === 'GET' && detailMatch) {
    const initiative = tm.get(detailMatch[1]);
    if (!initiative) return notFound(res);
    json(res, 200, initiative);
    return true;
  }

  // ── PATCH /api/initiatives/:id ──
  if (method === 'PATCH' && detailMatch) {
    const initiative = tm.get(detailMatch[1]);
    if (!initiative) return notFound(res);
    const patch = JSON.parse(await readBody(req)) as InitiativeUpdate;
    try {
      const updated = tm.update(initiative.id, patch);
      json(res, 200, updated);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // ── POST /api/initiatives/:id/notes ──
  const notesMatch = url.match(/^\/api\/initiatives\/([^/]+)\/notes$/);
  if (method === 'POST' && notesMatch) {
    const initiative = tm.get(notesMatch[1]);
    if (!initiative) return notFound(res);
    const body = JSON.parse(await readBody(req)) as { text?: string; kind?: InitiativeNoteKind };
    if (!body.text) {
      json(res, 400, { error: 'text is required' });
      return true;
    }
    const note = tm.addNote(initiative.id, body.text, body.kind ?? 'progress');
    json(res, 201, note);
    return true;
  }

  // ── POST /api/initiatives/:id/complete ──
  const completeMatch = url.match(/^\/api\/initiatives\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    const initiative = tm.get(completeMatch[1]);
    if (!initiative) return notFound(res);
    json(res, 200, tm.complete(initiative.id));
    return true;
  }

  // ── POST /api/initiatives/:id/abandon ──
  const abandonMatch = url.match(/^\/api\/initiatives\/([^/]+)\/abandon$/);
  if (method === 'POST' && abandonMatch) {
    const initiative = tm.get(abandonMatch[1]);
    if (!initiative) return notFound(res);
    const body = JSON.parse((await readBody(req)) || '{}') as { reason?: string };
    json(res, 200, tm.abandon(initiative.id, body.reason));
    return true;
  }

  return false;
}

function notFound(res: ServerResponse): true {
  json(res, 404, { error: 'initiative not found' });
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
