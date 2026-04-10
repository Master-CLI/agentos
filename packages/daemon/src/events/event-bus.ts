import { EventEmitter } from 'node:events';
import type { ProjectEvent } from './types.js';

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  publish(event: ProjectEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(handler: (event: ProjectEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => {
      this.emitter.off('event', handler);
    };
  }
}
