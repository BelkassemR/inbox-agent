import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRequest, insertRequest, saveAgentResult, transitionStatus, upsertRate, type Db } from "@inbox/core";
import { resetTestDb, setupTestDb } from "@inbox/core/testing";
import { AgentError, ScriptedLLM, type LLM } from "@inbox/agent";
import { createRedis, createWorker, Queues, TRIAGE_QUEUE, UnrecoverableError, type Job, type TriageJob } from "@inbox/queue";
import type { Redis } from "ioredis";
import { createMetrics } from "../src/metrics.ts";
import { makeDeliveryProcessor, makeTriageProcessor, type Mailer } from "../src/processors.ts";
import { sweepOnce } from "../src/sweeper.ts";

const REDIS_URL = (process.env.REDIS_URL ?? "redis://localhost:6379").replace(/\/\d*$/, "") + "/1";
let db: Db;
let redis: Redis;
let queues: Queues;
const business = { artistName: "NOVA", teamLanguage: "Dutch" };

const intake = async (body = "Wij willen je boeken voor ons festival op 14 juni 2027 in Utrecht, budget €20.000") =>
  (await insertRequest(db, { externalId: crypto.randomUUID(), channel: "email", senderName: "Sanne", senderEmail: "s@fest.nl", body })).request;

beforeAll(async () => {
  db = await setupTestDb();
  redis = createRedis(REDIS_URL);
  queues = new Queues(redis);
});
beforeEach(async () => {
  await resetTestDb(db);
  await redis.flushdb();
  await upsertRate(db, { eventType: "festival", region: "NL", minFeeEur: 15_000 });
});
afterAll(async () => {
  await queues.close();
  redis.disconnect();
  await db.end();
});

describe("triage worker", () => {
  it("processes queued requests end to end through Redis", async () => {
    const requests = await Promise.all([intake(), intake(), intake()]);
    const worker = createWorker(TRIAGE_QUEUE, makeTriageProcessor({ db, llm: new ScriptedLLM(), business, metrics: createMetrics(), today: () => "2026-11-27" }), createRedis(REDIS_URL), { concurrency: 3 });
    const done = new Promise<void>((resolve) => {
      let n = 0;
      worker.on("completed", () => ++n === requests.length && resolve());
    });
    for (const r of requests) await queues.enqueueTriage(r.id);
    await done;
    await worker.close();
    for (const r of requests) expect((await getRequest(db, r.id))!.status).toBe("needs_review");
  });

  it("deduplicates enqueues of the same request", async () => {
    const r = await intake();
    await queues.enqueueTriage(r.id);
    await queues.enqueueTriage(r.id);
    expect(await queues.triage.getWaitingCount()).toBe(1);
  });

  it("retries retryable failures and parks the request as failed after the last attempt", async () => {
    const flaky: LLM = { name: "flaky", createTurn: async () => { throw new AgentError("overloaded", true); } };
    const processor = makeTriageProcessor({ db, llm: flaky, business, metrics: createMetrics() });
    const r = await intake();
    const job = (attemptsMade: number) => ({ data: { requestId: r.id }, opts: { attempts: 3 }, attemptsMade }) as unknown as Job<TriageJob>;

    await expect(processor(job(0))).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect((await getRequest(db, r.id))!.status).toBe("queued");
    await expect(processor(job(2))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await getRequest(db, r.id))).toMatchObject({ status: "failed", error: expect.stringContaining("gave up after 3 attempts") });
  });
});

describe("sweeper", () => {
  it("re-enqueues requests that were never enqueued or whose worker died", async () => {
    const lost = await intake();
    const crashed = await intake();
    await transitionStatus(db, crashed.id, ["received"], "processing");
    await db.query("UPDATE requests SET updated_at = now() - interval '1 hour'");

    const n = await sweepOnce({ db, queues });
    expect(n).toBe(2);
    expect((await getRequest(db, lost.id))!.status).toBe("queued");
    expect((await getRequest(db, crashed.id))).toMatchObject({ status: "queued", error: "worker timed out; requeued" });
    expect(await queues.triage.getWaitingCount()).toBe(2);
  });
});

describe("delivery", () => {
  it("sends approved replies to the original sender exactly once", async () => {
    const sent: { to: string }[] = [];
    const mailer: Mailer = { send: async (m) => void sent.push(m) };
    const r = await intake();
    await transitionStatus(db, r.id, ["received"], "processing");
    await saveAgentResult(db, r.id, { category: "booking", priority: "high", extracted: {}, summary: "s", draftReply: "Hoi", riskFlags: [], trace: [] });
    await db.query("UPDATE requests SET status = 'approved' WHERE id = $1", [r.id]);

    const deliver = makeDeliveryProcessor({ db, mailer, metrics: createMetrics() });
    const job = { data: { requestId: r.id } } as Job<{ requestId: string }>;
    await deliver(job);
    await deliver(job);
    expect(sent).toEqual([expect.objectContaining({ to: "s@fest.nl" })]);
    expect((await getRequest(db, r.id))!.status).toBe("sent");
  });
});
