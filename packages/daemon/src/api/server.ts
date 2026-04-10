import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EventBus } from '../events/event-bus.js';
import type { TaskManager } from '../pipeline/task-manager.js';
import type { ReviewPipeline } from '../pipeline/review-pipeline.js';
import type { SuggestionEngine } from '../suggestions/suggestion-engine.js';
import type { MetricsCollector } from '../telemetry/metrics-collector.js';
import type { AuditLog } from '../telemetry/audit-log.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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
  taskManager?: TaskManager;
  reviewPipeline?: ReviewPipeline;
  suggestionEngine?: SuggestionEngine;
  metricsCollector?: MetricsCollector;
  auditLog?: AuditLog;
  configPath?: string;
}

export class ApiServer {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private eventBus: EventBus;
  private taskManager?: TaskManager;
  private reviewPipeline?: ReviewPipeline;
  private suggestionEngine?: SuggestionEngine;
  private metricsCollector?: MetricsCollector;
  private auditLog?: AuditLog;
  private configPath?: string;
  private unsubscribe?: () => void;

  constructor(private opts: ApiServerOptions) {
    this.eventBus = opts.eventBus;
    this.taskManager = opts.taskManager;
    this.reviewPipeline = opts.reviewPipeline;
    this.suggestionEngine = opts.suggestionEngine;
    this.metricsCollector = opts.metricsCollector;
    this.auditLog = opts.auditLog;
    this.configPath = opts.configPath;

    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
      ws.on('close', () => this.clients.delete(ws));
    });
  }

  setTaskManager(tm: TaskManager): void { this.taskManager = tm; }
  setReviewPipeline(rp: ReviewPipeline): void { this.reviewPipeline = rp; }
  setSuggestionEngine(se: SuggestionEngine): void { this.suggestionEngine = se; }
  setMetricsCollector(mc: MetricsCollector): void { this.metricsCollector = mc; }
  setAuditLog(al: AuditLog): void { this.auditLog = al; }
  setConfigPath(p: string): void { this.configPath = p; }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.opts.port, () => {
        this.unsubscribe = this.eventBus.subscribe((event) => {
          const msg = JSON.stringify(event);
          for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(msg);
            }
          }
        });

        // Forward task status changes over WebSocket
        this.taskManager?.events.on('task_status_changed', (data) => {
          const msg = JSON.stringify({ type: 'task_status_changed', ...data });
          for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(msg);
            }
          }
        });

        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
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

    // ── POST /api/dialog ──
    if (method === 'POST' && url === '/api/dialog') {
      if (!this.taskManager) return this.json(res, 503, { error: 'task manager not ready' });
      const body = await this.readBody(req);
      const { prompt } = JSON.parse(body);
      if (!prompt) return this.json(res, 400, { error: 'prompt is required' });

      const task = this.taskManager.create({
        prompt,
        origin: 'user',
        projectId: 'default',
      });

      // Start pipeline execution in background (non-blocking)
      if (this.reviewPipeline) {
        this.reviewPipeline.execute(task.id).catch(() => {
          // Pipeline errors are tracked in the task itself
        });
      }

      return this.json(res, 201, { task_id: task.id });
    }

    // ── GET /api/tasks ──
    if (method === 'GET' && url === '/api/tasks') {
      if (!this.taskManager) return this.json(res, 503, { error: 'task manager not ready' });
      return this.json(res, 200, this.taskManager.list());
    }

    // ── GET /api/tasks/:id ──
    const taskMatch = url.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === 'GET' && taskMatch) {
      if (!this.taskManager) return this.json(res, 503, { error: 'task manager not ready' });
      const task = this.taskManager.get(taskMatch[1]);
      if (!task) return this.json(res, 404, { error: 'task not found' });
      return this.json(res, 200, task);
    }

    // ── POST /api/tasks/:id/accept ──
    const acceptMatch = url.match(/^\/api\/tasks\/([^/]+)\/accept$/);
    if (method === 'POST' && acceptMatch) {
      if (!this.taskManager) return this.json(res, 503, { error: 'task manager not ready' });
      try {
        const task = this.taskManager.updateStatus(acceptMatch[1], 'completed');
        return this.json(res, 200, task);
      } catch {
        return this.json(res, 404, { error: 'task not found' });
      }
    }

    // ── POST /api/tasks/:id/discard ──
    const discardMatch = url.match(/^\/api\/tasks\/([^/]+)\/discard$/);
    if (method === 'POST' && discardMatch) {
      if (!this.taskManager) return this.json(res, 503, { error: 'task manager not ready' });
      try {
        const task = this.taskManager.updateStatus(discardMatch[1], 'cancelled');
        return this.json(res, 200, task);
      } catch {
        return this.json(res, 404, { error: 'task not found' });
      }
    }

    // ── GET /api/telemetry/metrics ──
    if (method === 'GET' && url === '/api/telemetry/metrics') {
      if (!this.metricsCollector) return this.json(res, 503, { error: 'metrics not ready' });
      return this.json(res, 200, this.metricsCollector.getMetrics(this.taskManager));
    }

    // ── GET /api/telemetry/traces?task_id=X ──
    if (method === 'GET' && url.startsWith('/api/telemetry/traces')) {
      if (!this.metricsCollector || !this.taskManager) return this.json(res, 503, { error: 'not ready' });
      const params = new URL(url, `http://localhost`).searchParams;
      const taskId = params.get('task_id');
      if (!taskId) return this.json(res, 400, { error: 'task_id required' });
      const trace = this.metricsCollector.getTaskTrace(this.taskManager, taskId);
      if (!trace) return this.json(res, 404, { error: 'task not found' });
      return this.json(res, 200, trace);
    }

    // ── PUT /api/settings ──
    if (method === 'PUT' && url === '/api/settings') {
      if (!this.configPath) return this.json(res, 503, { error: 'config not ready' });
      const body = await this.readBody(req);
      const updates = JSON.parse(body);
      const fs = await import('node:fs');
      let config: Record<string, unknown> = {};
      try { config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8')); } catch { /* fresh */ }
      Object.assign(config, updates);
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
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

    // ── POST /api/suggestions/:id/convert ──
    const convertMatch = url.match(/^\/api\/suggestions\/([^/]+)\/convert$/);
    if (method === 'POST' && convertMatch) {
      if (!this.suggestionEngine) return this.json(res, 503, { error: 'suggestion engine not ready' });
      try {
        const result = this.suggestionEngine.convertToTask(convertMatch[1]);
        return this.json(res, 201, result);
      } catch {
        return this.json(res, 404, { error: 'suggestion not found' });
      }
    }

    // ── Static files (Web UI) ──
    const webDir = resolveWebDir();
    if (webDir) {
      let filePath = nodePath.join(webDir, url === '/' ? 'index.html' : url);
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

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }
}
