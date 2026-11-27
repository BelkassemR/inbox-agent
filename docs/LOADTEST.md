# Load test

`loadtest/intake.ts` floods the signed intake webhook with booking requests, then measures how
quickly the workers drain the backlog through the **full** pipeline: claim, agent loop,
5 MCP tool calls per request (CRM, history, calendar, rates, hold, CRM write), result
persistence and audit log.

## Setup

- 1× API, 2× worker (concurrency 50 each), Postgres 16, Redis 7, all on one machine
  (4 vCPU Xeon @ 2.1 GHz, 16 GB RAM)
- `LLM_PROVIDER=scripted` with `SCRIPTED_LATENCY_MS=1000`. Each request takes 3 model turns,
  so this simulates about 3 s of model time per request. Real Claude latency varies with the
  request; the point here is the system around the model, not the model.

```bash
API_KEY=... WEBHOOK_SECRET=... DURATION=5 CONNECTIONS=50 tsx loadtest/intake.ts
```

## Results

| Metric | Result |
|---|---|
| Intake throughput (signed webhook → Postgres → Redis) | **~1,500 req/s**, p50 29 ms, p99 78 ms |
| Requests accepted in 5 s | 7,548, with 0 errors and 0 non-2xx |
| Requests processed end to end | 7,598 of 7,598 (0 lost, 0 failed) |
| Agent throughput | **~33 requests/s**, which equals concurrency (100) ÷ model time (3 s) |
| Pipeline overhead per request, excluding model time | **~20 ms** (avg run 3.02 s with 3.00 s simulated model time) |

An earlier 10-second run accepted about 14,700 requests at the same rate. Workers processed
them at a steady ~33/s with no failures.

## What this shows

- **Intake is decoupled from processing.** Bursts are absorbed at webhook speed and queued.
  Senders never wait for the model.
- **Agent throughput is bounded by `concurrency × replicas ÷ model latency`.** Agent runs are
  I/O-bound (waiting on the model), so throughput scales linearly by adding worker replicas
  or raising concurrency. The limits then become the Anthropic rate limit and the Postgres
  connection pool, not this code.
- **No lost or duplicate work under load**, thanks to idempotent intake, job-id dedupe and
  compare-and-set claims.

## Scaling further

- Worker replicas: `docker compose up --scale worker=N`
- Postgres connections: put PgBouncer in front once replicas × pool size gets close to
  `max_connections`
- Model rate limits: set worker concurrency to stay under your organization's limits.
  BullMQ backoff handles transient 429s.
- Cost: the system prompt and tool definitions are cached across requests, and the growing
  conversation is cached across turns. `inbox_llm_tokens_total{kind="cache_read"}` shows the
  effect.
