# Inbox Agent

**A Claude-powered agent that handles the inbox of an artist's management team.**
It triages every inbound message (bookings, brand deals, press, fan mail, spam), checks the
real calendar, CRM and rate cards through its own **MCP server**, places tentative holds, and
drafts a reply in the sender's language. A human approves every reply before it goes out.

![Review dashboard](docs/screenshots/review.png)

## What it does

A promoter emails: *"Can we book NOVA for our festival on 12 June in Utrecht? Budget €12,000."*

Within seconds, the agent:

1. **Looks up the sender** in the CRM and their history ("booked in 2026, paid on time")
2. **Checks the calendar** to see whether 12 June is free
3. **Looks up the minimum fee** for a festival in NL (€15,000), so it knows the budget is too low
4. **Places a tentative hold** so nobody else books the date while the team decides
5. **Saves the contact** in the CRM
6. **Drafts a reply** in Dutch that says the date looks available and the team will follow up
   with a proposal. It doesn't confirm anything and doesn't reveal the minimum fee.
7. **Flags it** with `budget_below_minimum` for the reviewer

The team sees it appear live in the dashboard, edits if needed, and clicks approve. Nothing
reaches the outside world without a human approving it.

| | |
|---|---|
| ![Prompt injection blocked](docs/screenshots/injection.png) | ![Agent trace](docs/screenshots/trace.png) |
| **Prompt injection**: detected in code, so the agent runs read-only and the reviewer is warned. | **Full trace**: every model turn, tool call, result and token count. |

## Architecture

```mermaid
flowchart LR
  subgraph Inbound
    E[Email / form / DM<br/>via signed webhook]
  end
  E -->|HMAC + timestamp| API[API<br/>Fastify]
  API -->|insert, idempotent| PG[(Postgres)]
  API -->|enqueue| R[(Redis / BullMQ)]
  R --> W1[Worker]
  R --> W2[Worker …]
  W1 -->|agent loop| C[Claude API]
  W1 <-->|MCP| M[MCP server<br/>calendar · CRM · rates · history]
  M --> PG
  W1 -->|draft + flags + trace| PG
  PG -.->|LISTEN/NOTIFY| API
  API -.->|SSE| D[Review dashboard<br/>React]
  D -->|approve / edit / reject| API
  API -->|enqueue delivery| R
  EXT[Claude Desktop /<br/>Claude Code] <-->|MCP over HTTP| API
```

| Package | Role |
|---|---|
| `packages/core` | Config, domain types, Postgres schema, migrations, repositories |
| `packages/mcp-server` | MCP server with the business tools (stdio, in-process and Streamable HTTP) |
| `packages/agent` | Agent loop on the Claude API, guards, tool policy, scripted offline model |
| `packages/queue` | BullMQ queues for triage and delivery |
| `apps/api` | Intake webhook, operator API, review endpoints, SSE, remote MCP, metrics |
| `apps/worker` | Runs the agent and delivery with retries, a recovery sweeper, metrics |
| `apps/dashboard` | Review UI with live updates (Dutch, for the team) |

## Design decisions

**MCP as the boundary between the agent and the business.** The agent doesn't touch the
database. It only calls MCP tools. The same server is available to Claude Desktop and Claude
Code (stdio or HTTP), so the team can also ask *"which Saturdays in June are free?"* from their
own Claude.

**Built on the Messages API with my own loop.** Approval gates, tool budgets, request-scoped
tools and a full audit trail need control over every turn. Details:
- Model `claude-opus-5-5` with adaptive thinking and an explicit `effort` setting
- A strict `submit_triage` tool as the final answer, validated again with zod
- Prompt caching (static system prompt and tools, growing conversation)
- Server-side refusal fallbacks, and checks on `stop_reason` before running any tool
- Append-only history, so thinking blocks and the cache stay valid
- Parallel tool calls, with all results returned in one turn

**Assume the model can be manipulated** ([full threat model](docs/SECURITY.md)):
- Inbound content is fenced as untrusted data, and hidden unicode is stripped
- A deterministic input guard switches the agent to **read-only**: write tools aren't offered at all
- Least privilege: the tools are scoped to the request, with 12 calls and 3 writes per run
- An output guard catches leaked fees, foreign email addresses and unknown links
- Every outbound reply needs human approval

**Postgres is the source of truth and Redis is only transport.** Intake is idempotent, every
status change is compare-and-set, and a sweeper rebuilds anything the queue lost. If Redis is
down, intake still returns 202.

**Measured, not assumed** ([load test](docs/LOADTEST.md)): about 1,500 intake requests/s
(p99 78 ms) on 4 vCPU, 0 requests lost under load, about 20 ms pipeline overhead per agent run,
and agent throughput that scales linearly with worker replicas.

## Run it

Requirements: Node 22+, pnpm, and Docker for Postgres and Redis.

```bash
pnpm install
cp .env.example .env              # set API_KEYS and WEBHOOK_SECRET
docker compose up -d postgres redis
set -a && . ./.env && set +a

pnpm db:seed                      # rate cards, calendar, contacts
pnpm dev:api                      # :3000
pnpm dev:worker
pnpm dev:dashboard                # :5173, log in with an API key from API_KEYS
pnpm demo                         # send 9 realistic messages
```

The agent runs **without an API key** by default (`LLM_PROVIDER=scripted`): a deterministic
stand-in that speaks the same tool-use protocol, so the whole pipeline works offline and in
CI. For the real agent:

```bash
LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... pnpm dev:worker
```

Or run everything with Docker: `docker compose up --build` (dashboard on `:8080`).

### Use the MCP server from Claude Code or Claude Desktop

```bash
# local, over stdio
claude mcp add inbox-agent --env DATABASE_URL=$DATABASE_URL -- pnpm -s --dir "$PWD" mcp

# remote, over HTTP (needs an operator API key)
claude mcp add --transport http inbox-agent https://your-host/mcp \
  --header "Authorization: Bearer $API_KEY"
```

## Tests

```bash
pnpm typecheck && pnpm test       # 79 tests against real Postgres and Redis
```

The tests cover webhook signatures and replay protection, idempotency, race conditions
(concurrent workers and reviewers), the MCP protocol end to end, agent loop edge cases
(refusals, truncation, invalid output, tool budgets), prompt-injection attempts with a model
that *falls for it*, retries and crash recovery through real Redis, and SSE.

## How it was built

In seven reviewable PRs, each split into focused commits:

1. **Foundation**: monorepo, schema, signed intake, operator API, CI
2. **MCP server**: business tools, MCP annotations, stdio and HTTP transports
3. **Agent**: Claude loop, strict output, tool policy, offline model, human review
4. **Security**: input and output guards, read-only mode, rate limits, threat model
5. **Scale**: queues, workers, retries, sweeper, metrics, load test
6. **Dashboard**: live review UI with trace and audit log
7. **Demo and docs**: seed data, demo scenario, this README

## Roadmap

- Real email and Instagram connectors (inbound and outbound) using an allowlisted provider
- SSO with per-user roles instead of static API keys
- An eval set of real (anonymized) messages to tune prompts and effort level per category
- Retention job for personal data (GDPR)

## License

MIT
