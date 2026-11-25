export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;

export function getContextWindowForModel(model: string): number {
  const trimmed = (model || "").trim();
  if (/\[1m\]/i.test(trimmed)) return 1_000_000;

  const lower = trimmed.toLowerCase();
  if (lower.includes("gpt-6")) return 1_050_000;
  if (lower.includes("gemini")) return 1_000_000;
  return MODEL_CONTEXT_WINDOW_DEFAULT;
}

export type TokenBudgetPayload = {
  used: number;
  total: number;
  percentage: number;
  model: string;
  usedTokens: number;
  maxContext: number;
  remainingTokens: number;
  usedPercent: number;
};

export function toTokenBudget(params: {
  promptTokens: number;
  completionTokens: number;
  model: string;
  maxContext?: number;
}): TokenBudgetPayload {
  const usedTokens = Math.max(0, Math.floor(params.promptTokens + params.completionTokens));
  const maxContext = Math.max(1, params.maxContext ?? getContextWindowForModel(params.model));
  const usedPercent = Math.max(0, Math.min(100, (usedTokens / maxContext) * 100));
  return {
    used: usedTokens,
    total: maxContext,
    percentage: usedPercent,
    model: params.model,
    usedTokens,
    maxContext,
    remainingTokens: Math.max(0, maxContext - usedTokens),
    usedPercent,
  };
}
