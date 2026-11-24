import { expect, test } from "bun:test";
import { createMcpPlugin } from "../plugins/builtins";
import { PluginRuntime } from "../plugins/runtime";
import { createToolDisclosure } from "../tools/disclosure";
import type { ToolContext } from "../tools/types";

test("MCP discovery handles pages, preserves schema and dispatches real HTTP calls", async () => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request: Request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json()) as any;
      seen.push(message.method);
      if (message.id === undefined) return new Response(null, { status: 202 });
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      } else if (message.method === "tools/list") {
        const page = message.params?.cursor;
        result = {
          tools: [
            {
              name: page ? "second" : "first",
              description: "test tool",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
                additionalProperties: false,
              },
              annotations: { readOnlyHint: true },
            },
          ],
          ...(page ? {} : { nextCursor: "next" }),
        };
      } else if (message.method === "tools/call")
        result = {
          content: [{ type: "text", text: message.params.arguments.text }],
        };
      else
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unknown method" },
        });
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  });
  const runtime = await PluginRuntime.create([createMcpPlugin([{
    name: "fixture", transport: "http", url: `http://127.0.0.1:${server.port}/mcp`,
  }])], {});
  try {
    const registry = runtime.registry;
    const context = { permissionMode: "plan" } as ToolContext;
    const discovery = createToolDisclosure(registry, context);
    await discovery.dispatch("search_tools", { query: "" }, context);
    expect(seen).toEqual([]);
    await discovery.dispatch("search_tools", { query: "first", toolset: "fixture" }, context);
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "mcp__fixture__first",
      "mcp__fixture__second",
    ]);
    expect(
      registry.get("mcp__fixture__first")?.parameters.additionalProperties,
    ).toBe(false);
    const result = await registry.dispatch(
      "mcp__fixture__second",
      { text: "from second page" },
      { permissionMode: "plan" } as ToolContext,
    );
    expect(result.content).toBe("from second page");
    expect(seen.filter((method) => method === "tools/list")).toHaveLength(2);
  } finally {
    await runtime.dispose();
    server.stop(true);
  }
});
