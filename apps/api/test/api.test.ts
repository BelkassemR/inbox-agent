import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db, InboundRequest } from "@inbox/core";
import { resetTestDb } from "@inbox/core/testing";
import { auth, makeApp, samplePayload, setupTestDb, signedIntake } from "./helpers.ts";

let db: Db;
let app: FastifyInstance;
const received: InboundRequest[] = [];

beforeAll(async () => {
  db = await setupTestDb();
  app = await makeApp(db, { onNewRequest: async (r) => void received.push(r) });
});
beforeEach(async () => {
  await resetTestDb(db);
  received.length = 0;
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("intake webhook", () => {
  it("accepts a correctly signed request and notifies once", async () => {
    const res = await app.inject(signedIntake(samplePayload));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: "received", duplicate: false });
    expect(received).toHaveLength(1);
  });

  it("deduplicates redelivered webhooks", async () => {
    const a = await app.inject(signedIntake(samplePayload));
    const b = await app.inject(signedIntake(samplePayload));
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ id: a.json().id, duplicate: true });
    expect(received).toHaveLength(1);
  });

  it("rejects bad signatures, wrong secrets and replayed timestamps", async () => {
    const tampered = signedIntake(samplePayload);
    tampered.payload = tampered.payload.replace("Utrecht", "Amsterdam");
    expect((await app.inject(tampered)).statusCode).toBe(401);
    expect((await app.inject(signedIntake(samplePayload, { secret: "wrong-secret-0123456789" }))).statusCode).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 3600;
    expect((await app.inject(signedIntake(samplePayload, { ts: stale }))).statusCode).toBe(401);
  });

  it("validates the payload", async () => {
    const res = await app.inject(signedIntake({ ...samplePayload, channel: "fax" } as unknown as Record<string, unknown>));
    expect(res.statusCode).toBe(400);
  });
});

describe("operator API", () => {
  it("requires an API key", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/requests" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/requests", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
  });

  it("lists and fetches requests", async () => {
    const { id } = (await app.inject(signedIntake(samplePayload))).json();
    const list = await app.inject({ method: "GET", url: "/v1/requests", headers: auth });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].preview).toContain("Zomerfest");

    const one = await app.inject({ method: "GET", url: `/v1/requests/${id}`, headers: auth });
    expect(one.json()).toMatchObject({ id, senderEmail: "sanne@zomerfest.nl" });
    expect(one.json().audit[0].action).toBe("request.received");
  });

  it("returns 404 for unknown and 400 for malformed ids", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/requests/7f0c1f8e-1111-4c3e-9a7a-111111111111", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/requests/not-a-uuid", headers: auth })).statusCode).toBe(400);
  });
});

describe("health", () => {
  it("reports liveness and readiness", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
});

describe("hardening", () => {
  it("sets security headers", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("does not allow arbitrary browser origins", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/v1/requests", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits clients", async () => {
    const limited = await makeApp(db, { config: { API_KEYS: ["x".repeat(20)], WEBHOOK_SECRET: "y".repeat(20), RATE_LIMIT_PER_MINUTE: 3 } });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await limited.inject({ method: "GET", url: "/v1/requests" })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    await limited.close();
  });
});
