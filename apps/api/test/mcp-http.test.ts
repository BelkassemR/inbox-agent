import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { upsertRate, type Db } from "@inbox/core";
import { resetTestDb } from "@inbox/core/testing";
import { API_KEY, makeApp, setupTestDb } from "./helpers.ts";

let db: Db;
let app: FastifyInstance;
let url: URL;

beforeAll(async () => {
  db = await setupTestDb();
  await resetTestDb(db);
  app = await makeApp(db);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  url = new URL("/mcp", address);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

const connect = async (key: string) => {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
};

describe("remote MCP endpoint", () => {
  it("serves tools to an authenticated MCP client", async () => {
    await upsertRate(db, { eventType: "festival", region: "NL", minFeeEur: 10_000 });
    const client = await connect(API_KEY);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const res = await client.callTool({ name: "rates_lookup", arguments: { event_type: "festival", region: "NL" } });
    expect(JSON.parse((res.content as { text: string }[])[0]!.text).minFeeEur).toBe(10_000);
    await client.close();
  });

  it("rejects clients without a valid API key", async () => {
    await expect(connect("wrong-key-0000000000000")).rejects.toThrow();
  });
});
