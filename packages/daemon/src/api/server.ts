import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { EventBus } from '../events/event-bus.js';
import type { TaskManager } from '../pipeline/task-manager.js';
import type { ReviewPipeline } from '../pipeline/review-pipeline.js';
import type { SuggestionEngine } from '../suggestions/suggestion-engine.js';

export interface ApiServerOptions {
  port: number;
  eventBus: EventBus;
  taskManager?: TaskManager;
  reviewPipeline?: ReviewPipeline;
  suggestionEngine?: SuggestionEngine;
}

export class ApiServer {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private eventBus: EventBus;
  private taskManager?: TaskManager;
  private reviewPipeline?: ReviewPipeline;
  private suggestionEngine?: SuggestionEngine;
  private unsubscribe?: () => void;

  constructor(private opts: ApiServerOptions) {
    this.eventBus = opts.eventBus;
    this.taskManager = opts.taskManager;
    this.reviewPipeline = opts.reviewPipeline;
    this.suggestionEngine = opts.suggestionEngine;

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
