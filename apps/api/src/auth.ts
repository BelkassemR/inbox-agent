import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Bearer API-key auth for operator endpoints. Keys are compared as SHA-256
 * digests with timingSafeEqual, so comparison time leaks neither the key nor its length.
 * Returns an operator id derived from the key (never the key itself) for audit logs.
 */
export function apiKeyAuth(keys: string[]) {
  const known = keys.map((k) => ({ digest: digest(k), id: `op:${digest(k).toString("hex").slice(0, 8)}` }));
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const candidate = digest(token);
    // Check every key (no early exit) to keep timing independent of which key matched.
    let match: string | null = null;
    for (const k of known) if (timingSafeEqual(k.digest, candidate)) match = k.id;
    if (!match) return reply.code(401).send({ error: "unauthorized" });
    req.operator = match;
  };
}

export const SIGNATURE_HEADER = "x-signature";
export const TIMESTAMP_HEADER = "x-timestamp";
const MAX_SKEW_SECONDS = 300;

export function signWebhook(secret: string, timestamp: number, rawBody: string | Buffer): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

/**
 * Verify an inbound webhook: HMAC-SHA256 over `${timestamp}.${rawBody}`.
 * Signing the timestamp and rejecting old ones blocks replay of captured requests.
 */
export function verifyWebhook(
  secret: string,
  headers: { signature?: string; timestamp?: string },
  rawBody: Buffer,
  now: number = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: string } {
  const ts = Number(headers.timestamp);
  if (!headers.signature || !Number.isInteger(ts)) return { ok: false, reason: "missing signature" };
  if (Math.abs(now - ts) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale timestamp" };
  const expected = Buffer.from(signWebhook(secret, ts, rawBody));
  const given = Buffer.from(headers.signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true };
}

declare module "fastify" {
  interface FastifyRequest {
    operator?: string;
    rawBody?: Buffer;
  }
}
