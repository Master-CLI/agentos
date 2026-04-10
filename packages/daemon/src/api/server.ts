import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { EventBus } from '../events/event-bus.js';

export interface ApiServerOptions {
  port: number;
  eventBus: EventBus;
}

export class ApiServer {
  private httpServer: Server;
  private wss: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private eventBus: EventBus;
  private unsubscribe?: () => void;

  constructor(private opts: ApiServerOptions) {
    this.eventBus = opts.eventBus;

    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
      ws.on('close', () => this.clients.delete(ws));
    });
  }

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

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
}
