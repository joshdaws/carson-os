import { EventEmitter } from "node:events";

export interface AppEvent {
  type: string;
  data?: unknown;
}

export type BroadcastFn = (event: AppEvent) => void;

type EventHandler = (event: AppEvent) => void;

export class AppEventBus {
  private emitter = new EventEmitter();

  publish: BroadcastFn = (event) => {
    this.emitter.emit(event.type, event);
    this.emitter.emit("*", event);
  };

  on(type: string, handler: EventHandler): () => void {
    this.emitter.on(type, handler);
    return () => this.emitter.off(type, handler);
  }
}
