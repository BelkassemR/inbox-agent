import { Queue, Worker, type Job, type JobsOptions, type Processor, type WorkerOptions } from "bullmq";
import { Redis } from "ioredis";

export const TRIAGE_QUEUE = "triage";
export const DELIVERY_QUEUE = "delivery";

export interface TriageJob {
  requestId: string;
}
export interface DeliveryJob {
  requestId: string;
}

/** BullMQ needs `maxRetriesPerRequest: null` on connections used by blocking workers. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}

const baseJobOptions: JobsOptions = {
  attempts: 5,
  // 5s, 10s, 20s, 40s… gives rate limits and provider hiccups time to clear.
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
};

export class Queues {
  readonly triage: Queue<TriageJob>;
  readonly delivery: Queue<DeliveryJob>;

  constructor(readonly connection: Redis) {
    this.triage = new Queue<TriageJob>(TRIAGE_QUEUE, { connection, defaultJobOptions: baseJobOptions });
    this.delivery = new Queue<DeliveryJob>(DELIVERY_QUEUE, { connection, defaultJobOptions: baseJobOptions });
  }

  /**
   * Enqueue triage. The job id is the request id, so enqueueing the same request twice
   * (e.g. webhook redelivery racing the sweeper) is a no-op. Pass a `retryKey` to
   * deliberately enqueue again after an earlier job finished or failed.
   */
  async enqueueTriage(requestId: string, retryKey?: string): Promise<void> {
    await this.triage.add("triage", { requestId }, { jobId: retryKey ? `${requestId}_${retryKey}` : requestId });
  }

  async enqueueDelivery(requestId: string): Promise<void> {
    await this.delivery.add("deliver", { requestId }, { jobId: `deliver_${requestId}` });
  }

  async depth(): Promise<{ triage: Record<string, number>; delivery: Record<string, number> }> {
    const kinds = ["waiting", "active", "delayed", "failed", "completed"] as const;
    return {
      triage: await this.triage.getJobCounts(...kinds),
      delivery: await this.delivery.getJobCounts(...kinds),
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.triage.close(), this.delivery.close()]);
  }
}

export function createWorker<T>(
  name: string,
  processor: Processor<T>,
  connection: Redis,
  opts: Partial<WorkerOptions> = {},
): Worker<T> {
  return new Worker<T>(name, processor, { connection, concurrency: 8, ...opts });
}

export { Queue, Worker, type Job };
export { UnrecoverableError } from "bullmq";
