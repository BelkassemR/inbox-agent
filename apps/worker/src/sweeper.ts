import { findStale, transitionStatus, type Db, type Logger } from "@inbox/core";
import type { Queues } from "@inbox/queue";
import type { Metrics } from "./metrics.ts";

export interface SweeperOptions {
  db: Db;
  queues: Queues;
  metrics?: Metrics;
  logger?: Logger;
  /** Requests stored but never enqueued (e.g. Redis was down at intake). */
  receivedAfterSeconds?: number;
  /** Queued requests with no progress (job lost or retries exhausted elsewhere). */
  queuedAfterSeconds?: number;
  /** Processing for too long: the worker probably crashed mid-run. */
  processingAfterSeconds?: number;
  /** Approved but not delivered. */
  approvedAfterSeconds?: number;
}

/**
 * Recovery loop. The database is the source of truth and the queue is only
 * transport, so anything the queue lost can be rebuilt from request states.
 * Every action is safe to repeat: triage claims are compare-and-set.
 */
export async function sweepOnce(o: SweeperOptions): Promise<number> {
  const bucket = String(Math.floor(Date.now() / 60_000)); // at most one forced re-enqueue per request per minute
  let n = 0;

  for (const id of await findStale(o.db, "received", o.receivedAfterSeconds ?? 30)) {
    await o.queues.enqueueTriage(id);
    await transitionStatus(o.db, id, ["received"], "queued");
    o.metrics?.swept.inc({ from: "received" });
    n++;
  }
  for (const id of await findStale(o.db, "queued", o.queuedAfterSeconds ?? 15 * 60)) {
    await o.queues.enqueueTriage(id, `sweep${bucket}`);
    o.metrics?.swept.inc({ from: "queued" });
    n++;
  }
  for (const id of await findStale(o.db, "processing", o.processingAfterSeconds ?? 10 * 60)) {
    if (await transitionStatus(o.db, id, ["processing"], "queued", { error: "worker timed out; requeued" })) {
      await o.queues.enqueueTriage(id, `sweep${bucket}`);
      o.metrics?.swept.inc({ from: "processing" });
      n++;
    }
  }
  for (const id of await findStale(o.db, "approved", o.approvedAfterSeconds ?? 60)) {
    await o.queues.enqueueDelivery(id);
    n++;
  }
  if (n) o.logger?.info({ requeued: n }, "sweeper requeued requests");
  return n;
}

export function startSweeper(o: SweeperOptions, intervalMs = 30_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepOnce(o);
    } catch (err) {
      o.logger?.error({ err }, "sweeper failed");
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
