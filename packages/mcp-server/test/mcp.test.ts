import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { auditForRequest, insertEvent, insertRequest, upsertRate, type Db } from "@inbox/core";
import { resetTestDb, setupTestDb } from "@inbox/core/testing";
import { createMcpServer, TOOL_NAMES, zonedToUtc } from "../src/index.ts";

let db: Db;

async function connect(requestId?: string) {
  const server = createMcpServer({ db, actor: "agent", requestId, excludeRequestId: requestId });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { type: string; text: string }[])[0]!.text;
  return { isError: Boolean(res.isError), text, json: res.isError ? null : JSON.parse(text) };
}

const nextYear = new Date().getFullYear() + 1;
const D = (md: string) => `${nextYear}-${md}`;

beforeEach(async () => {
  db ??= await setupTestDb();
  await resetTestDb(db);
});
afterAll(async () => db?.end());

describe("MCP server", () => {
  it("advertises tools with schemas and safety annotations", async () => {
    const { tools } = await (await connect()).listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(Object.values(TOOL_NAMES).sort());
    const avail = tools.find((t) => t.name === TOOL_NAMES.checkAvailability)!;
    expect(avail.annotations?.readOnlyHint).toBe(true);
    expect(avail.inputSchema.required).toEqual(["from", "to"]);
    const hold = tools.find((t) => t.name === TOOL_NAMES.createHold)!;
    expect(hold.annotations?.destructiveHint).toBe(false);
  });

  it("hides request_id from the hold tool when scoped to a request", async () => {
    const { request } = await insertRequest(db, { externalId: "x", channel: "email", senderName: "A", body: "b" });
    const scoped = await (await connect(request.id)).listTools();
    const unscoped = await (await connect()).listTools();
    const props = (c: typeof scoped) => Object.keys(c.tools.find((t) => t.name === TOOL_NAMES.createHold)!.inputSchema.properties ?? {});
    expect(props(scoped)).not.toContain("request_id");
    expect(props(unscoped)).toContain("request_id");
  });

  it("reports free, tentative and busy dates in Europe/Amsterdam", async () => {
    await insertEvent(db, { title: "Show Ahoy", kind: "show", startsAt: zonedToUtc(D("06-13"), "20:00"), endsAt: zonedToUtc(D("06-13"), "23:30") });
    const client = await connect();
    const { json } = await call(client, TOOL_NAMES.checkAvailability, { from: D("06-12"), to: D("06-14") });
    expect(json.freeDates).toEqual([D("06-12"), D("06-14")]);
    expect(json.events[0]).toMatchObject({ date: D("06-13"), start: "20:00", title: "Show Ahoy" });
  });

  it("returns validation errors to the model instead of throwing", async () => {
    const client = await connect();
    const bad = await call(client, TOOL_NAMES.checkAvailability, { from: "13-06-2027", to: D("06-14") });
    expect(bad.isError).toBe(true);
    const tooWide = await call(client, TOOL_NAMES.checkAvailability, { from: D("01-01"), to: D("12-31") });
    expect(tooWide.isError).toBe(true);
    expect(tooWide.text).toContain("range too large");
  });

  it("places idempotent tentative holds, refuses conflicts, and audits", async () => {
    const { request } = await insertRequest(db, { externalId: "x", channel: "email", senderName: "A", body: "b" });
    await insertEvent(db, { title: "Show", kind: "show", startsAt: zonedToUtc(D("07-01"), "20:00"), endsAt: zonedToUtc(D("07-01"), "23:00") });
    const client = await connect(request.id);

    const clash = await call(client, TOOL_NAMES.createHold, { date: D("07-01"), title: "HOLD – Test" });
    expect(clash.json).toMatchObject({ placed: false });

    const first = await call(client, TOOL_NAMES.createHold, { date: D("07-02"), title: "HOLD – Test", location: "Utrecht" });
    const again = await call(client, TOOL_NAMES.createHold, { date: D("07-02"), title: "HOLD – Test" });
    expect(first.json).toMatchObject({ placed: true, alreadyExisted: false, status: "tentative" });
    expect(again.json).toMatchObject({ placed: true, alreadyExisted: true, holdId: first.json.holdId });

    const log = await auditForRequest(db, request.id);
    expect(log.filter((l) => l.action === "calendar.hold_created")).toHaveLength(1);
    expect(log[0]!.actor).toBe("agent");
  });

  it("refuses holds in the past", async () => {
    const { request } = await insertRequest(db, { externalId: "x", channel: "email", senderName: "A", body: "b" });
    const res = await call(await connect(request.id), TOOL_NAMES.createHold, { date: "2020-01-01", title: "HOLD – Old" });
    expect(res.isError).toBe(true);
  });

  it("upserts and finds contacts", async () => {
    const client = await connect();
    await call(client, TOOL_NAMES.upsertContact, { name: "Sanne", email: "sanne@zomerfest.nl", organization: "Zomerfest", tags: ["promoter"] });
    const byEmail = await call(client, TOOL_NAMES.findContact, { email: "SANNE@zomerfest.nl" });
    const byName = await call(client, TOOL_NAMES.findContact, { name: "zomer" });
    expect(byEmail.json.contacts[0]).toMatchObject({ organization: "Zomerfest" });
    expect(byName.json.found).toBe(true);
  });

  it("looks up rates and lists known types on a miss", async () => {
    await upsertRate(db, { eventType: "festival", region: "NL", minFeeEur: 10_000 });
    const client = await connect();
    expect((await call(client, TOOL_NAMES.rates, { event_type: "festival", region: "nl" })).json.minFeeEur).toBe(10_000);
    expect((await call(client, TOOL_NAMES.rates, { event_type: "wedding", region: "NL" })).json).toEqual({ found: false, knownEventTypes: ["festival"] });
  });

  it("returns sender history without the current request", async () => {
    const a = await insertRequest(db, { externalId: "1", channel: "email", senderName: "A", senderEmail: "a@x.nl", subject: "old", body: "b" });
    const b = await insertRequest(db, { externalId: "2", channel: "email", senderName: "A", senderEmail: "a@x.nl", subject: "new", body: "b" });
    const res = await call(await connect(b.request.id), TOOL_NAMES.history, { email: "a@x.nl" });
    expect(res.json.previousRequests.map((r: { subject: string }) => r.subject)).toEqual(["old"]);
    expect(a.created).toBe(true);
  });
});
