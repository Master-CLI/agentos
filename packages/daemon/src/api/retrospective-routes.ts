/**
 * Retrospective — API route handlers.
 *
 * Thin HTTP adapter over {@link RetrospectiveEngine}.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RetrospectiveEngine } from '../retrospectives/engine.js';

export interface RetrospectiveRouteContext {
  retrospectiveEngine?: RetrospectiveEngine;
}

export async function handleRetrospectiveRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RetrospectiveRouteContext,
): Promise<boolean> {
  const url = req.url ?? '';
  const method = req.method ?? '';

  if (!url.startsWith('/api/retrospectives')) return false;

  const engine = ctx.retrospectiveEngine;
  if (!engine) {
    json(res, 503, { error: 'retrospective engine not ready' });
    return true;
  }

  // ── GET /api/retrospectives ──
  if (method === 'GET' && url === '/api/retrospectives') {
    json(res, 200, engine.list());
    return true;
  }

  // ── POST /api/retrospectives/generate ──
  if (method === 'POST' && url === '/api/retrospectives/generate') {
    const body = JSON.parse((await readBody(req)) || '{}') as {
      windowMs?: number;
      windowStart?: string;
      windowEnd?: string;
    };
    try {
      const report = engine.generate({
        windowMs: typeof body.windowMs === 'number' ? body.windowMs : undefined,
        windowStart: body.windowStart,
        windowEnd: body.windowEnd,
      });
      json(res, 201, report);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // ── GET /api/retrospectives/:id ──
  const detailMatch = url.match(/^\/api\/retrospectives\/([^/]+)$/);
  if (method === 'GET' && detailMatch) {
    const report = engine.get(detailMatch[1]);
    if (!report) {
      json(res, 404, { error: 'retrospective not found' });
      return true;
    }
    json(res, 200, report);
    return true;
  }

  return false;
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
