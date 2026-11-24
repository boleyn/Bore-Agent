import { expect, test } from "bun:test";
import { searchTools } from "./semanticSearch";
import type { ToolDefinition } from "./types";

test("hybrid search recovers a semantic match and survives provider failure", async () => {
  const tools = ["ledger", "warehouse"].map(name => ({
    name, description: name, toolset: "business", parameters: { type: "object", properties: {} },
    handler: async () => ({ content: "" }),
  } satisfies ToolDefinition));
  let failing = false;
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request: Request) {
    requests++;
    if (failing) return new Response("", { status: 503 });
    const { input } = await request.json() as { input: string[] };
    return Response.json({ data: input.map((text, index) => ({ index, embedding: text.includes("warehouse") ? [0, 1] : [1, 0] })) });
  } });
  const url = process.env.BORE_TOOL_EMBEDDINGS_URL;
  const model = process.env.BORE_TOOL_EMBEDDINGS_MODEL;
  try {
    process.env.BORE_TOOL_EMBEDDINGS_URL = server.url.toString();
    process.env.BORE_TOOL_EMBEDDINGS_MODEL = "test";
    expect((await searchTools(tools, "财务账本"))[0].tool.name).toBe("ledger");
    expect(requests).toBe(2);
    await searchTools(tools, "查看账目");
    expect(requests).toBe(3);
    failing = true;
    expect((await searchTools(tools, "warehouse inventory"))[0].tool.name).toBe("warehouse");
  } finally {
    server.stop(true);
    if (url === undefined) delete process.env.BORE_TOOL_EMBEDDINGS_URL;
    else process.env.BORE_TOOL_EMBEDDINGS_URL = url;
    if (model === undefined) delete process.env.BORE_TOOL_EMBEDDINGS_MODEL;
    else process.env.BORE_TOOL_EMBEDDINGS_MODEL = model;
  }
});
