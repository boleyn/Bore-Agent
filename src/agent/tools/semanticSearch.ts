import { createHash } from "node:crypto";
import { rankTools } from "./search";
import type { ToolDefinition } from "./types";

const vectors = new Map<string, number[]>();

/** Candidates have already passed the registry's access checks. Only tool
 * metadata goes to the configured embedding provider, never execution results. */
export async function searchTools(candidates: ToolDefinition<any>[], query: string, signal?: AbortSignal) {
  const lexical = rankTools(candidates, query);
  const endpoint = process.env.BORE_TOOL_EMBEDDINGS_URL;
  const model = process.env.BORE_TOOL_EMBEDDINGS_MODEL;
  if (!endpoint || !model || !candidates.length || lexical[0]?.tool.name.toLowerCase() === query.trim().toLowerCase()) return lexical;

  const timeout = AbortSignal.timeout(3000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const documents = candidates.map(tool => [tool.name, tool.toolset, tool.description, ...Object.keys(tool.parameters.properties || {})].join(" ").slice(0, 2000));
  const keys = documents.map(doc => createHash("sha256").update(JSON.stringify([endpoint, model, doc])).digest("hex"));
  const batchSize = 64;
  const request = async (input: string[]) => {
    const key = process.env.BORE_TOOL_EMBEDDINGS_API_KEY;
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: requestSignal,
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, input }),
    });
    if (!response.ok) throw new Error("Embedding service unavailable");
    const result = await response.json() as { data: { index: number; embedding: number[] }[] };
    const rows = result.data.sort((a, b) => a.index - b.index);
    if (rows.length !== input.length) throw new Error("Incomplete embedding response");
    return rows.map(({ index, embedding }, i) => {
      if (index !== i || !Array.isArray(embedding) || !embedding.length || embedding.length > 8192 || !embedding.every(Number.isFinite)) throw new Error("Invalid embedding");
      const norm = Math.hypot(...embedding);
      if (!norm) throw new Error("Empty embedding");
      return embedding.map(value => value / norm);
    });
  };
  try {
    const missing = documents.map((_, i) => i).filter(i => !vectors.has(keys[i]));
    const [queryVector] = await request([query.slice(0, 2000)]);
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      const rows = await request(batch.map(i => documents[i]));
      batch.forEach((i, j) => {
        if (vectors.size >= 4096) vectors.delete(vectors.keys().next().value!);
        vectors.set(keys[i], rows[j]);
      });
    }
    const semantic = candidates.map((tool, i) => {
      const vector = vectors.get(keys[i]);
      const score = vector?.length === queryVector.length ? vector.reduce((sum, v, j) => sum + v * queryVector[j], 0) : 0;
      return { tool, score };
    }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score);
    const scores = new Map<ToolDefinition<any>, number>();
    for (const ranking of [lexical, semantic]) {
      ranking.slice(0, 50).forEach(({ tool }, i) => scores.set(tool, (scores.get(tool) || 0) + 1 / (61 + i)));
    }
    return [...scores].map(([tool, score]) => ({ tool, score })).sort((a, b) => b.score - a.score);
  } catch (error) {
    if (signal?.aborted) throw error;
    return lexical;
  }
}
