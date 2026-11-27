import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createHold,
  findContactByEmail,
  insertEvent,
  insertRequest,
  listRequests,
  lookupRate,
  reviewRequest,
  saveAgentResult,
  searchContactsByName,
  transitionStatus,
  upsertContact,
  upsertRate,
  type Db,
} from "../src/index.ts";
import { resetTestDb, setupTestDb } from "../src/testing.ts";

let db: Db;
const payload = {
  externalId: "msg-1",
  channel: "email" as const,
  senderName: "Sanne de Vries",
  senderEmail: "sanne@festival.nl",
  subject: "Booking request",
  body: "Hi! We'd love to book you for our festival.",
};

beforeEach(async () => {
  db ??= await setupTestDb();
  await resetTestDb(db);
});
afterAll(async () => db?.end());

describe("requests", () => {
  it("is idempotent on (channel, externalId)", async () => {
    const a = await insertRequest(db, payload);
    const b = await insertRequest(db, payload);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.request.id).toBe(a.request.id);
  });

  it("only transitions from an expected status (compare-and-set)", async () => {
    const { request } = await insertRequest(db, payload);
    expect(await transitionStatus(db, request.id, ["received"], "processing")).not.toBeNull();
    // A second worker trying the same transition loses the race.
    expect(await transitionStatus(db, request.id, ["received"], "processing")).toBeNull();
  });

  it("saves agent output and allows exactly one review", async () => {
    const { request } = await insertRequest(db, payload);
    await transitionStatus(db, request.id, ["received"], "processing");
    const saved = await saveAgentResult(db, request.id, {
      category: "booking",
      priority: "high",
      extracted: { city: "Utrecht" },
      summary: "Festival booking",
      draftReply: "Thanks!",
      riskFlags: [],
      trace: [],
    });
    expect(saved?.status).toBe("needs_review");
    const approved = await reviewRequest(db, request.id, "approved", "op:test", "Thanks, edited");
    expect(approved?.draftReply).toBe("Thanks, edited");
    expect(await reviewRequest(db, request.id, "rejected", "op:other")).toBeNull();
  });

  it("paginates with a keyset cursor", async () => {
    for (let i = 0; i < 5; i++) {
      await insertRequest(db, { ...payload, externalId: `m-${i}`, receivedAt: `2026-01-0${i + 1}T10:00:00Z` });
    }
    const first = await listRequests(db, { limit: 2 });
    const last = first.at(-1)!;
    const second = await listRequests(db, {
      limit: 2,
      before: { receivedAt: last.receivedAt.toISOString(), id: last.id },
    });
    expect(first.map((r) => r.externalId)).toEqual(["m-4", "m-3"]);
    expect(second.map((r) => r.externalId)).toEqual(["m-2", "m-1"]);
  });
});

describe("contacts", () => {
  it("upserts by email case-insensitively and appends notes", async () => {
    const a = await upsertContact(db, { name: "Sanne", email: "Sanne@Festival.nl", note: "first" });
    const b = await upsertContact(db, { name: "Sanne de Vries", email: "sanne@festival.nl", note: "second", tags: ["promoter"] });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    const found = await findContactByEmail(db, "SANNE@festival.nl");
    expect(found?.name).toBe("Sanne de Vries");
    expect(found?.notes).toBe("first\nsecond");
    expect(found?.tags).toEqual(["promoter"]);
  });

  it("treats LIKE wildcards in search input literally", async () => {
    await upsertContact(db, { name: "Club 100%", email: "a@b.nl" });
    await upsertContact(db, { name: "Other", email: "c@d.nl" });
    expect(await searchContactsByName(db, "%")).toHaveLength(1);
  });
});

describe("calendar holds", () => {
  it("refuses holds that overlap confirmed events and is idempotent per request/day", async () => {
    const { request } = await insertRequest(db, payload);
    await insertEvent(db, {
      title: "Show Rotterdam",
      kind: "show",
      startsAt: new Date("2026-06-12T18:00:00Z"),
      endsAt: new Date("2026-06-12T23:00:00Z"),
    });
    const clash = await createHold(db, {
      requestId: request.id,
      title: "Hold",
      startsAt: new Date("2026-06-12T19:00:00Z"),
      endsAt: new Date("2026-06-12T22:00:00Z"),
    });
    expect(clash.ok).toBe(false);

    const free = { requestId: request.id, title: "Hold", startsAt: new Date("2026-06-13T19:00:00Z"), endsAt: new Date("2026-06-13T22:00:00Z") };
    const first = await createHold(db, free);
    const again = await createHold(db, free);
    expect(first.ok && first.created).toBe(true);
    expect(again.ok && !again.created).toBe(true);
  });
});

describe("rates", () => {
  it("falls back to the default region", async () => {
    await upsertRate(db, { eventType: "festival", region: "default", minFeeEur: 8000 });
    await upsertRate(db, { eventType: "festival", region: "BE", minFeeEur: 9500 });
    expect((await lookupRate(db, "festival", "be"))?.minFeeEur).toBe(9500);
    expect((await lookupRate(db, "festival", "NL"))?.minFeeEur).toBe(8000);
    expect(await lookupRate(db, "wedding", "NL")).toBeNull();
  });
});
