import { EventEmitter } from "node:events";
import pg from "pg";
import type { Logger } from "@inbox/core";

export interface RequestEvent {
  id: string;
  status: string;
  previousStatus: string | null;
  category: string | null;
  priority: string | null;
  at: string;
}

/**
 * One dedicated LISTEN connection per API process, fanned out to any number of SSE
 * clients. Reconnects with backoff if the connection drops.
 */
export class RequestEventBus extends EventEmitter {
  private client: pg.Client | null = null;
  private stopped = false;

  constructor(private readonly connectionString: string, private readonly logger?: Logger) {
    super();
    this.setMaxListeners(0);
  }

  async start(): Promise<void> {
    let delay = 500;
    while (!this.stopped) {
      try {
        const client = new pg.Client({ connectionString: this.connectionString });
        await client.connect();
        await client.query("LISTEN request_events");
        client.on("notification", (msg) => {
          if (!msg.payload) return;
          try {
            this.emit("event", JSON.parse(msg.payload) as RequestEvent);
          } catch {
            /* ignore malformed payloads */
          }
        });
        client.on("error", (err) => {
          this.logger?.warn({ err }, "event listener connection lost; reconnecting");
          this.client = null;
          void client.end().catch(() => {});
          if (!this.stopped) setTimeout(() => void this.start(), delay);
        });
        this.client = client;
        return;
      } catch (err) {
        this.logger?.warn({ err, delay }, "could not start event listener; retrying");
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.client?.end().catch(() => {});
  }
}
