import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type ToolContext } from "@inbox/mcp-server";
import type { Tool } from "./llm.ts";

export interface McpToolInfo {
  tool: Tool;
  readOnly: boolean;
}

export interface ToolCallOutcome {
  isError: boolean;
  text: string;
}

/**
 * Connects the agent to the MCP server. In-process by default (no network hop),
 * but the agent only ever talks MCP, so swapping in a remote server is a transport change.
 */
export class McpToolbox {
  private constructor(
    private readonly client: Client,
    private readonly cleanup: () => Promise<void>,
  ) {}

  static async inProcess(ctx: ToolContext, onError?: (err: unknown) => void): Promise<McpToolbox> {
    const server = createMcpServer(ctx, { onError });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inbox-agent", version: "0.1.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    return new McpToolbox(client, async () => {
      await client.close();
      await server.close();
    });
  }

  static fromClient(client: Client): McpToolbox {
    return new McpToolbox(client, () => client.close());
  }

  /** MCP tool listing mapped to Claude tool definitions (the JSON Schemas line up 1:1). */
  async listTools(): Promise<McpToolInfo[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      tool: {
        name: t.name,
        description: t.description ?? t.title ?? t.name,
        input_schema: t.inputSchema as Tool["input_schema"],
      },
      readOnly: t.annotations?.readOnlyHint === true,
    }));
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text?: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { isError: Boolean(res.isError), text };
  }

  close(): Promise<void> {
    return this.cleanup();
  }
}
