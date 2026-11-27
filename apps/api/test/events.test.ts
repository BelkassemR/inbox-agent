import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { transitionStatus, type Db } from "@inbox/core";
import { resetTestDb, TEST_DATABASE_URL } from "@inbox/core/testing";
import { RequestEventBus } from "../src/events.ts";
import { API_KEY, makeApp, samplePayload, setupTestDb, signedIntake } from "./helpers.ts";

let db: Db;
let app: FastifyInstance;
let bus: RequestEventBus;
let base: string;

beforeAll(async () => {
  db = await setupTestDb();
  await resetTestDb(db);
  bus = new RequestEventBus(TEST_DATABASE_URL);
  await bus.start();
  app = await makeApp(db, { events: bus });
  base = await app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await bus.stop();
  await app.close();
  await db.end();
});

describe("live events", () => {
  it("streams request changes made by any writer over SSE", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/v1/events`, { headers: { authorization: `Bearer ${API_KEY}` }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { id } = (await app.inject(signedIntake(samplePayload))).json();
    await transitionStatus(db, id, ["received"], "processing"); // e.g. a worker in another process

    let buf = "";
    const events: { id: string; status: string }[] = [];
    while (events.length < 2) {
      buf += decoder.decode((await reader.read()).value);
      for (const m of buf.matchAll(/^data: (.*)$/gm)) {
        const e = JSON.parse(m[1]!);
        if (!events.some((x) => x.status === e.status)) events.push(e);
      }
    }
    ctrl.abort();
    expect(events.map((e) => [e.id, e.status])).toEqual([[id, "received"], [id, "processing"]]);
  });

  it("requires auth", async () => {
    expect((await fetch(`${base}/v1/events`)).status).toBe(401);
  });
});
