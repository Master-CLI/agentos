import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '../events/event-bus.js';
import type { SuggestionEngine } from '../suggestions/suggestion-engine.js';
import type { MetricsCollector } from '../telemetry/metrics-collector.js';
import type { AuditLog } from '../telemetry/audit-log.js';
import type { DialogHandler } from '../dialog/dialog-handler.js';
import type { DesignTaskManager } from '../design-iteration/design-task-manager.js';
import type { DesignPipeline } from '../design-iteration/design-pipeline.js';
import type { InitiativeManager } from '../initiatives/manager.js';
import type { RetrospectiveEngine } from '../retrospectives/engine.js';
import { handleDesignRoute } from './design-routes.js';
import { handleInitiativeRoute } from './initiative-routes.js';
import { handleRetrospectiveRoute } from './retrospective-routes.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Maximum request body size (1 MB). */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Allowed settings keys and their type validators.
 * Inferred from daemon.ts: auto_execute (boolean), retrospective.intervalMs (number),
 * watch_paths (string[]).
 */
const SETTINGS_WHITELIST: Record<string, (v: unknown) => boolean> = {
  auto_execute: (v) => typeof v === 'boolean',
  retrospective: (v) =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v as object).every(
      (k) => k === 'intervalMs' && typeof (v as Record<string, unknown>)[k] === 'number',
    ),
  watch_paths: (v) => Array.isArray(v) && (v as unknown[]).every((item) => typeof item === 'string'),
};

function resolveWebDir(): string | null {
  try {
    // Resolve from daemon package: ../../web/dist
    const thisDir = nodePath.dirname(fileURLToPath(import.meta.url));
    const candidate = nodePath.resolve(thisDir, '..', '..', '..', 'web', 'dist');
    if (fs.existsSync(nodePath.join(candidate, 'index.html'))) return candidate;
  } catch { /* ignore */ }
  return null;
}

export interface ApiServerOptions {
  port: number;
  eventBus: EventBus;
  dialogHandler?: DialogHandler;
  suggestionEngine?: SuggestionEngine;
  designTaskManager?: DesignTaskManager;
  designPipeline?: DesignPipeline;
  initiativeManager?: InitiativeManager;
  retrospectiveEngine?: RetrospectiveEngine;
  metricsCollector?: MetricsCollector;
  auditLog?: AuditLog;
  configPath?: string;
}

export class ApiServer {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private eventBus: EventBus;
  private dialogHandler?: DialogHandler;
  private suggestionEngine?: SuggestionEngine;
  private designTaskManager?: DesignTaskManager;
  private designPipeline?: DesignPipeline;
  private initiativeManager?: InitiativeManager;
  private retrospectiveEngine?: RetrospectiveEngine;
  private metricsCollector?: MetricsCollector;
  private auditLog?: AuditLog;
  private configPath?: string;
  private unsubscribe?: () => void;

  // P2-5: fs-event coalescing
  private fsBatchBuffer: unknown[] = [];
  private fsBatchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: ApiServerOptions) {
    this.eventBus = opts.eventBus;
    this.dialogHandler = opts.dialogHandler;
    this.suggestionEngine = opts.suggestionEngine;
    this.designTaskManager = opts.designTaskManager;
    this.designPipeline = opts.designPipeline;
    this.initiativeManager = opts.initiativeManager;
    this.retrospectiveEngine = opts.retrospectiveEngine;
    this.metricsCollector = opts.metricsCollector;
    this.auditLog = opts.auditLog;
    this.configPath = opts.configPath;

    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    // P0-3: WebSocket Origin check
    this.wss.on('connection', (ws, req) => {
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let allowed = false;
        try {
          const { hostname } = new URL(origin);
          allowed = hostname === 'localhost' || hostname === '127.0.0.1';
        } catch {
          allowed = false;
        }
        if (!allowed) {
          ws.close(1008, 'Origin not allowed');
          return;
        }
      }
      // origin is undefined (non-browser client) or allowed hostname
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  setDialogHandler(dh: DialogHandler): void { this.dialogHandler = dh; }
  setSuggestionEngine(se: SuggestionEngine): void { this.suggestionEngine = se; }
  setDesignTaskManager(tm: DesignTaskManager): void { this.designTaskManager = tm; }
  setDesignPipeline(dp: DesignPipeline): void { this.designPipeline = dp; }
  setInitiativeManager(im: InitiativeManager): void { this.initiativeManager = im; }
  setRetrospectiveEngine(re: RetrospectiveEngine): void { this.retrospectiveEngine = re; }
  setMetricsCollector(mc: MetricsCollector): void { this.metricsCollector = mc; }
  setAuditLog(al: AuditLog): void { this.auditLog = al; }
  setConfigPath(p: string): void { this.configPath = p; }

  start(): Promise<void> {
    return new Promise((resolve) => {
      // P0-1: Bind to localhost only
      this.httpServer.listen(this.opts.port, '127.0.0.1', () => {
        this.unsubscribe = this.eventBus.subscribe((event) => {
          // P2-5: Coalesce fs events; broadcast non-fs events immediately
          if ((event as { source?: string }).source === 'fs') {
            this.fsBatchBuffer.push(event);
            if (this.fsBatchTimer === null) {
              this.fsBatchTimer = setTimeout(() => {
                const batch = this.fsBatchBuffer.splice(0);
                this.fsBatchTimer = null;
                for (const ev of batch) {
                  const msg = JSON.stringify(ev);
                  for (const client of this.clients) {
                    if (client.readyState === WebSocket.OPEN) {
                      client.send(msg);
                    }
                  }
                }
              }, 250);
            }
          } else {
            const msg = JSON.stringify(event);
            for (const client of this.clients) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
              }
            }
          }
        });

        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      // P2-5: Clear any pending fs batch timer
      if (this.fsBatchTimer !== null) {
        clearTimeout(this.fsBatchTimer);
        this.fsBatchTimer = null;
        this.fsBatchBuffer = [];
      }
      this.unsubscribe?.();
      for (const client of this.clients) {
        client.close();
      }
      this.wss.close();
      this.httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  get port(): number {
    const addr = this.httpServer.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.opts.port;
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const method = req.method ?? '';

    // ── Health ──
    if (method === 'GET' && url === '/health') {
      return this.json(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
    }

    // ── POST /api/dialog — 项目问答 ──
    if (method === 'POST' && url === '/api/dialog') {
      if (!this.dialogHandler) return this.json(res, 503, { error: 'dialog not ready' });

      // P1-12: Harden body reading
      let body: string;
      try {
        body = await this.readBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'payload too large') {
          return this.json(res, 413, { error: 'payload too large' });
        }
        return this.json(res, 400, { error: 'bad request' });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return this.json(res, 400, { error: 'invalid JSON' });
      }

      const { question } = parsed as Record<string, unknown>;
      if (!question) return this.json(res, 400, { error: 'question is required' });

      // Stream output via WebSocket while waiting for answer
      const onOutput = (chunk: string, stream: 'stdout' | 'stderr') => {
        const msg = JSON.stringify({ type: 'dialog_stream', payload: { chunk, stream } });
        for (const client of this.clients) {
          if (client.readyState === WebSocket.OPEN) client.send(msg);
        }
      };

      try {
        const answer = await this.dialogHandler.ask(question as string, onOutput);
        return this.json(res, 200, answer);
      } catch (err) {
        return this.json(res, 500, { error: String(err) });
      }
    }

    // ── GET /api/dialog/history ──
    if (method === 'GET' && url === '/api/dialog/history') {
      if (!this.dialogHandler) return this.json(res, 503, { error: 'dialog not ready' });
      return this.json(res, 200, this.dialogHandler.getHistory());
    }

    // ── GET /api/dialog/context — 当前项目上下文 ──
    if (method === 'GET' && url === '/api/dialog/context') {
      if (!this.dialogHandler) return this.json(res, 503, { error: 'dialog not ready' });
      return this.json(res, 200, this.dialogHandler.getContext());
    }

    // ── GET /api/telemetry/metrics ──
    if (method === 'GET' && url === '/api/telemetry/metrics') {
      if (!this.metricsCollector) return this.json(res, 503, { error: 'metrics not ready' });
      return this.json(res, 200, this.metricsCollector.getMetrics());
    }

    // ── GET /api/telemetry/events — recent event summary ──
    if (method === 'GET' && url === '/api/telemetry/events') {
      if (!this.metricsCollector) return this.json(res, 503, { error: 'not ready' });
      return this.json(res, 200, this.metricsCollector.getMetrics());
    }

    // ── PUT /api/settings ──
    if (method === 'PUT' && url === '/api/settings') {
      if (!this.configPath) return this.json(res, 503, { error: 'config not ready' });

      // P1-12: Harden body reading
      let body: string;
      try {
        body = await this.readBody(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'payload too large') {
          return this.json(res, 413, { error: 'payload too large' });
        }
        return this.json(res, 400, { error: 'bad request' });
      }

      let updates: unknown;
      try {
        updates = JSON.parse(body);
      } catch {
        return this.json(res, 400, { error: 'invalid JSON' });
      }

      // P1-13: Settings whitelist validation
      if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) {
        return this.json(res, 400, { error: 'settings must be an object' });
      }
      for (const key of Object.keys(updates as object)) {
        if (!(key in SETTINGS_WHITELIST)) {
          return this.json(res, 400, { error: `unknown setting: ${key}` });
        }
        const validate = SETTINGS_WHITELIST[key];
        if (!validate((updates as Record<string, unknown>)[key])) {
          return this.json(res, 400, { error: `invalid value for setting: ${key}` });
        }
      }

      const fsModule = await import('node:fs');
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(fsModule.readFileSync(this.configPath, 'utf-8')); } catch { /* fresh */ }
      Object.assign(config, updates as Record<string, unknown>);
      fsModule.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      return this.json(res, 200, config);
    }

    // ── GET /api/audit ──
    if (method === 'GET' && url.startsWith('/api/audit')) {
      if (!this.auditLog) return this.json(res, 503, { error: 'audit not ready' });
      const params = new URL(url, `http://localhost`).searchParams;
      const from = params.get('from') ?? undefined;
      const to = params.get('to') ?? undefined;
      return this.json(res, 200, this.auditLog.query({ from, to }));
    }

    // ── GET /api/suggestions ──
    if (method === 'GET' && url === '/api/suggestions') {
      if (!this.suggestionEngine) return this.json(res, 503, { error: 'suggestion engine not ready' });
      return this.json(res, 200, this.suggestionEngine.list());
    }

    // ── POST /api/suggestions/:id/dismiss ──
    const dismissMatch = url.match(/^\/api\/suggestions\/([^/]+)\/dismiss$/);
    if (method === 'POST' && dismissMatch) {
      if (!this.suggestionEngine) return this.json(res, 503, { error: 'suggestion engine not ready' });
      try {
        const s = this.suggestionEngine.dismiss(dismissMatch[1]);
        return this.json(res, 200, s);
      } catch {
        return this.json(res, 404, { error: 'suggestion not found' });
      }
    }

    // ── POST /api/suggestions/:id/acknowledge ──
    const ackMatch = url.match(/^\/api\/suggestions\/([^/]+)\/acknowledge$/);
    if (method === 'POST' && ackMatch) {
      if (!this.suggestionEngine) return this.json(res, 503, { error: 'suggestion engine not ready' });
      try {
        const s = this.suggestionEngine.acknowledge(ackMatch[1]);
        return this.json(res, 200, s);
      } catch {
        return this.json(res, 404, { error: 'suggestion not found' });
      }
    }

    // ── Design iteration routes ──
    const designHandled = await handleDesignRoute(req, res, {
      designTaskManager: this.designTaskManager,
      designPipeline: this.designPipeline,
    });
    if (designHandled) return;

    // ── Initiative routes ──
    const initiativeHandled = await handleInitiativeRoute(req, res, {
      initiativeManager: this.initiativeManager,
    });
    if (initiativeHandled) return;

    // ── Retrospective routes ──
    const retrospectiveHandled = await handleRetrospectiveRoute(req, res, {
      retrospectiveEngine: this.retrospectiveEngine,
    });
    if (retrospectiveHandled) return;

    // ── Static files (Web UI) ──
    const webDir = resolveWebDir();
    if (webDir) {
      // P0-2: Path traversal guard
      // Strip query string, decode percent-encoding, reject any remaining '..'
      const rawPathname = url.split('?')[0];
      let decodedPathname: string;
      try {
        decodedPathname = decodeURIComponent(rawPathname);
      } catch {
        return this.json(res, 400, { error: 'bad request' });
      }
      if (decodedPathname.includes('..')) {
        return this.json(res, 403, { error: 'forbidden' });
      }
      const candidate = nodePath.resolve(webDir, decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\//, ''));
      if (candidate !== webDir && !candidate.startsWith(webDir + nodePath.sep)) {
        return this.json(res, 403, { error: 'forbidden' });
      }

      let filePath = candidate;
      // SPA fallback: non-API, non-file paths → index.html
      if (!fs.existsSync(filePath)) {
        filePath = nodePath.join(webDir, 'index.html');
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = nodePath.extname(filePath);
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
    }

    return this.json(res, 404, { error: 'not found' });
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  // P1-12: Cap body at 1 MB; reject on overflow.
  // On overflow we drain (resume) the stream rather than destroying it so the
  // caller can still write a 413 response over the same socket before closing.
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let byteCount = 0;
      let overLimit = false;
      req.on('data', (chunk: Buffer) => {
        if (overLimit) return; // discard; stream already draining
        byteCount += chunk.length;
        if (byteCount > MAX_BODY_BYTES) {
          overLimit = true;
          // Drain remaining data so the socket stays writable for the 413 response.
          req.resume();
          reject(new Error('payload too large'));
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => {
        if (!overLimit) resolve(body);
      });
      req.on('error', (err) => {
        if (!overLimit) reject(err);
      });
    });
  }
}
