import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  checkAvailability,
  checkAvailabilityInput,
  createHoldInput,
  createHoldUnscopedInput,
  findContact,
  findContactInput,
  history,
  historyInput,
  placeHold,
  rates,
  ratesInput,
  saveContact,
  ToolInputError,
  upsertContactInput,
  type ToolContext,
} from "./tools.ts";

/** Tool names, shared with the agent's policy layer. */
export const TOOL_NAMES = {
  checkAvailability: "calendar_check_availability",
  createHold: "calendar_create_hold",
  findContact: "crm_find_contact",
  upsertContact: "crm_upsert_contact",
  rates: "rates_lookup",
  history: "requests_history",
} as const;

function wrap<A>(fn: (args: A) => Promise<unknown>, onError?: (err: unknown) => void) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      // Input errors are returned to the model so it can correct itself;
      // anything else is logged and reported generically (no internals leak).
      if (err instanceof ToolInputError) return { isError: true, content: [{ type: "text", text: err.message }] };
      onError?.(err);
      return { isError: true, content: [{ type: "text", text: "internal error while running tool" }] };
    }
  };
}

export function createMcpServer(ctx: ToolContext, opts: { onError?: (err: unknown) => void } = {}): McpServer {
  const server = new McpServer({ name: "inbox-agent", version: "0.1.0" });
  const e = opts.onError;

  server.registerTool(
    TOOL_NAMES.checkAvailability,
    {
      title: "Check calendar availability",
      description:
        "List the artist's calendar events between two dates and which dates are free. Use before proposing or holding a date.",
      inputSchema: checkAvailabilityInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap((a) => checkAvailability(ctx, a), e),
  );

  // When scoped to a request, the request id is fixed by the server and not
  // accepted from the model, so a manipulated model can't touch other requests.
  if (ctx.requestId) {
    server.registerTool(
      TOOL_NAMES.createHold,
      {
        title: "Place tentative hold",
        description:
          "Place a TENTATIVE hold on a free date for this request. Never confirms a booking; a human confirms later. Fails if the date conflicts with a confirmed event.",
        inputSchema: createHoldInput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => placeHold(ctx, a), e),
    );
  } else {
    server.registerTool(
      TOOL_NAMES.createHold,
      {
        title: "Place tentative hold",
        description: "Place a TENTATIVE hold on a free date for an inbound request. Fails on conflicts with confirmed events.",
        inputSchema: createHoldUnscopedInput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      wrap((a) => placeHold(ctx, a), e),
    );
  }

  server.registerTool(
    TOOL_NAMES.findContact,
    {
      title: "Find CRM contact",
      description: "Look up a contact in the CRM by exact email or by (partial) name/organization.",
      inputSchema: findContactInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap((a) => findContact(ctx, a), e),
  );

  server.registerTool(
    TOOL_NAMES.upsertContact,
    {
      title: "Save CRM contact",
      description: "Create or update a CRM contact by email. Notes are appended to history, never overwritten.",
      inputSchema: upsertContactInput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap((a) => saveContact(ctx, a), e),
  );

  server.registerTool(
    TOOL_NAMES.rates,
    {
      title: "Look up minimum fee",
      description: "Get the minimum fee (EUR) for an event type in a region. Returns known event types if there is no match.",
      inputSchema: ratesInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap((a) => rates(ctx, a), e),
  );

  server.registerTool(
    TOOL_NAMES.history,
    {
      title: "Sender history",
      description: "Earlier requests from the same sender, with their outcome.",
      inputSchema: historyInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap((a) => history(ctx, a), e),
  );

  return server;
}
