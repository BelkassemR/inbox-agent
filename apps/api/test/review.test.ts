import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { auditForRequest, createHold, insertRequest, saveAgentResult, transitionStatus, type Db, type InboundRequest } from "@inbox/core";
import { resetTestDb } from "@inbox/core/testing";
import { auth, makeApp, setupTestDb } from "./helpers.ts";

let db: Db;
let app: FastifyInstance;
const approved: InboundRequest[] = [];
const retried: InboundRequest[] = [];

async function reviewable() {
  const { request } = await insertRequest(db, { externalId: crypto.randomUUID(), channel: "email", senderName: "S", body: "b" });
  await transitionStatus(db, request.id, ["received"], "processing");
  await saveAgentResult(db, request.id, { category: "booking", priority: "high", extracted: {}, summary: "s", draftReply: "Draft", riskFlags: [], trace: [] });
  return request.id;
}

beforeAll(async () => {
  db = await setupTestDb();
  app = await makeApp(db, { onApproved: async (r) => void approved.push(r), onNewRequest: async (r) => void retried.push(r) });
});
beforeEach(async () => {
  await resetTestDb(db);
  approved.length = 0;
  retried.length = 0;
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("review", () => {
  it("approves with an edited reply and records who did it", async () => {
    const id = await reviewable();
    const res = await app.inject({ method: "POST", url: `/v1/requests/${id}/approve`, headers: auth, payload: { reply: "Edited" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "approved", draftReply: "Edited", reviewedBy: expect.stringMatching(/^op:/) });
    expect(approved).toHaveLength(1);
    const log = await auditForRequest(db, id);
    expect(log.at(-1)).toMatchObject({ action: "review.approved", details: { edited: true } });
  });

  it("lets only one of two concurrent reviewers win", async () => {
    const id = await reviewable();
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/requests/${id}/approve`, headers: auth }),
      app.inject({ method: "POST", url: `/v1/requests/${id}/reject`, headers: auth }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it("releases tentative holds on rejection", async () => {
    const id = await reviewable();
    await createHold(db, { requestId: id, title: "HOLD", startsAt: new Date("2030-06-01T17:00:00Z"), endsAt: new Date("2030-06-01T21:00:00Z") });
    const res = await app.inject({ method: "POST", url: `/v1/requests/${id}/reject`, headers: auth, payload: { reason: "too small" } });
    expect(res.statusCode).toBe(200);
    const { rows } = await db.query("SELECT count(*)::int AS n FROM calendar_events");
    expect(rows[0].n).toBe(0);
  });

  it("retries failed requests and clears the error", async () => {
    const { request } = await insertRequest(db, { externalId: "f", channel: "email", senderName: "S", body: "b" });
    await transitionStatus(db, request.id, ["received"], "failed", { error: "boom" });
    const res = await app.inject({ method: "POST", url: `/v1/requests/${request.id}/retry`, headers: auth });
    expect(res.json()).toMatchObject({ status: "queued", error: null });
    expect(retried).toHaveLength(1);
  });

  it("requires auth", async () => {
    const id = await reviewable();
    expect((await app.inject({ method: "POST", url: `/v1/requests/${id}/approve` })).statusCode).toBe(401);
  });
});
