/**
 * Load test: flood the signed intake webhook, then measure how fast the workers drain
 * the backlog through the full agent pipeline (MCP tools, Postgres, audit).
 *
 *   API_URL=http://localhost:3000 WEBHOOK_SECRET=... API_KEY=... tsx loadtest/intake.ts
 *
 * Options (env): CONNECTIONS (50), DURATION seconds (15), DRAIN_TIMEOUT seconds (600).
 */
import autocannon from "autocannon";
import { createHmac, randomUUID } from "node:crypto";

const API = process.env.API_URL ?? "http://localhost:3000";
const SECRET = process.env.WEBHOOK_SECRET!;
const KEY = process.env.API_KEY!;
if (!SECRET || !KEY) throw new Error("WEBHOOK_SECRET and API_KEY are required");

const cities = ["Utrecht", "Amsterdam", "Rotterdam", "Antwerpen", "Gent", "Eindhoven"];
const months = ["maart", "april", "mei", "juni", "juli", "augustus"];

function body() {
  const n = Math.floor(Math.random() * 1e6);
  return JSON.stringify({
    externalId: randomUUID(),
    channel: "email",
    senderName: `Promoter ${n}`,
    senderEmail: `promoter${n}@example.org`,
    subject: "Boeking",
    body: `Hoi! Wij willen je boeken voor ons festival op ${1 + (n % 28)} ${months[n % months.length]} 2027 in ${cities[n % cities.length]}. Budget €${10 + (n % 15)}.000, ${1000 + (n % 9000)} bezoekers.`,
  });
}

function sign(payload: string) {
  const ts = Math.floor(Date.now() / 1000);
  return { ts, sig: "sha256=" + createHmac("sha256", SECRET).update(`${ts}.`).update(payload).digest("hex") };
}

async function stats() {
  const res = await fetch(`${API}/v1/stats`, { headers: { authorization: `Bearer ${KEY}` } });
  return (await res.json()) as { byStatus: Record<string, number> };
}

const before = await stats();
const startCount = Object.values(before.byStatus).reduce((a, b) => a + b, 0);

const result = await autocannon({
  url: `${API}/v1/intake`,
  connections: Number(process.env.CONNECTIONS ?? 50),
  duration: Number(process.env.DURATION ?? 15),
  requests: [
    {
      method: "POST",
      setupRequest: (req) => {
        const payload = body();
        const { ts, sig } = sign(payload);
        return { ...req, body: payload, headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-signature": sig } };
      },
    },
  ],
});

const accepted = result["2xx"];
console.log(`\nIntake: ${accepted} accepted, ${result.non2xx} non-2xx, ${result.errors} errors`);
console.log(`Throughput: ${result.requests.average.toFixed(0)} req/s avg | latency p50 ${result.latency.p50} ms, p99 ${result.latency.p99} ms`);

// Drain: wait until nothing is received/queued/processing.
const t0 = Date.now();
const timeout = Number(process.env.DRAIN_TIMEOUT ?? 600) * 1000;
let pending = Infinity;
while (Date.now() - t0 < timeout) {
  const s = (await stats()).byStatus;
  pending = (s.received ?? 0) + (s.queued ?? 0) + (s.processing ?? 0);
  process.stdout.write(`\rDraining… pending=${pending}   `);
  if (pending === 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const drainSec = (Date.now() - t0) / 1000;
const after = await stats();
const total = Object.values(after.byStatus).reduce((a, b) => a + b, 0) - startCount;
console.log(`\nDrained ${total} requests in ${drainSec.toFixed(1)} s after intake stopped (${pending} still pending).`);
console.log("Final status counts:", after.byStatus);
