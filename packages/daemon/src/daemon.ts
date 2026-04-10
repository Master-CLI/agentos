import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventBus } from './events/event-bus.js';
import { EventStore } from './events/event-store.js';
import { ApiServer } from './api/server.js';

export interface DaemonOptions {
  projectDir: string;
  port: number;
}

export class Daemon {
  private eventBus: EventBus;
  private eventStore: EventStore;
  private apiServer: ApiServer;
  private agentosDir: string;

  constructor(private opts: DaemonOptions) {
    this.agentosDir = path.join(opts.projectDir, '.agentos');
    if (!fs.existsSync(this.agentosDir)) {
      throw new Error(`.agentos directory not found in ${opts.projectDir}. Run 'agentos init' first.`);
    }

    this.eventBus = new EventBus();
    this.eventStore = new EventStore(path.join(this.agentosDir, 'events.db'));
    this.apiServer = new ApiServer({ port: opts.port, eventBus: this.eventBus });
  }

  appendAndPublish(event: Parameters<EventStore['append']>[0]): void {
    const full = this.eventStore.append(event);
    this.eventBus.publish(full);
  }

  async start(): Promise<void> {
    await this.eventStore.ensureReady();
    await this.apiServer.start();

    // Write PID file
    const pidPath = path.join(this.agentosDir, 'daemon.pid');
    fs.writeFileSync(pidPath, String(process.pid));
  }

  async stop(): Promise<void> {
    await this.apiServer.stop();
    this.eventStore.close();

    // Remove PID file
    const pidPath = path.join(this.agentosDir, 'daemon.pid');
    if (fs.existsSync(pidPath)) {
      fs.unlinkSync(pidPath);
    }
  }

  get port(): number {
    return this.apiServer.port;
  }

  getEventStore(): EventStore {
    return this.eventStore;
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }
}
