import type { FastifyInstance } from "fastify";
import type { Db, IntakePayload } from "@inbox/core";
import { setupTestDb } from "@inbox/core/testing";
import { buildApp, type AppDeps } from "../src/app.ts";
import { signWebhook } from "../src/auth.ts";

export const API_KEY = "test-operator-key-0123456789";
export const WEBHOOK_SECRET = "test-webhook-secret-0123456789";
export const auth = { authorization: `Bearer ${API_KEY}` };

export async function makeApp(db: Db, extra: Partial<AppDeps> = {}): Promise<FastifyInstance> {
  return buildApp({ config: { API_KEYS: [API_KEY], WEBHOOK_SECRET }, db, ...extra });
}

export { setupTestDb };

export function signedIntake(payload: object, opts: { ts?: number; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  return {
    method: "POST" as const,
    url: "/v1/intake",
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-signature": signWebhook(opts.secret ?? WEBHOOK_SECRET, ts, body),
    },
  };
}

export const samplePayload: IntakePayload = {
  externalId: "mail-001",
  channel: "email",
  senderName: "Sanne de Vries",
  senderEmail: "sanne@zomerfest.nl",
  subject: "Boeking Zomerfest 2027",
  body: "Hoi! Wij willen je graag boeken voor Zomerfest op 14 juni 2027 in Utrecht. Budget rond de 12.000 euro, 5000 bezoekers.",
};
