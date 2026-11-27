#!/usr/bin/env -S node --import tsx
/**
 * Run the MCP server over stdio, e.g. for Claude Desktop or Claude Code:
 *
 *   claude mcp add inbox-agent --env DATABASE_URL=postgres://... -- pnpm --dir /path/to/inbox-agent --filter @inbox/mcp-server start
 *
 * stdout carries the protocol, so all diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPool } from "@inbox/core";
import { createMcpServer } from "./server.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const db = createPool(url, 3);
const server = createMcpServer({ db, actor: "mcp:stdio" }, { onError: (err) => console.error(err) });
await server.connect(new StdioServerTransport());
console.error("inbox-agent MCP server running on stdio");
