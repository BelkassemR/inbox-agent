import type { FastifyInstance } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Db } from "@inbox/core";
import { createMcpServer } from "@inbox/mcp-server";

/**
 * Remote MCP endpoint (Streamable HTTP, stateless): lets Claude Desktop / Claude Code
 * or any MCP client use the team's calendar and CRM tools over HTTPS.
 * Mounted inside the authenticated scope, so it requires an operator API key.
 */
export async function mcpRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.post("/mcp", async (req, reply) => {
    // Stateless mode: a fresh server + transport per request, so any API replica can serve any call.
    const server = createMcpServer({ db: opts.db, actor: req.operator ?? "mcp:http" }, { onError: (err) => req.log.error({ err }, "mcp tool error") });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(405).send({ error: "method not allowed (stateless MCP server)" });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
