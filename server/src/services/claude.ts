/**
 * Claude integration -- direct Anthropic SDK wrapper.
 *
 * No adapter abstraction. If a second provider is needed later,
 * this module becomes the seam where an adapter interface is introduced.
 */

import Anthropic from "@anthropic-ai/sdk";

// Cost per million tokens in cents (approximate, April 2026)
const COST_PER_M_INPUT: Record<string, number> = {
  "claude-haiku-4-5-20251001": 100,
  "claude-sonnet-4-20250514": 300,
  "claude-opus-4-20250514": 1500,
};
const COST_PER_M_OUTPUT: Record<string, number> = {
  "claude-haiku-4-5-20251001": 500,
  "claude-sonnet-4-20250514": 1500,
  "claude-opus-4-20250514": 7500,
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return client;
}

export async function executeAgent(params: {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  model: string;
  maxTokens?: number;
}): Promise<{
  content: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}> {
  const anthropic = getClient();

  const response = await anthropic.messages.create({
    model: params.model,
    max_tokens: params.maxTokens ?? 2048,
    system: params.systemPrompt,
    messages: params.messages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  const content = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  const inputCostPerM = COST_PER_M_INPUT[params.model] ?? 300;
  const outputCostPerM = COST_PER_M_OUTPUT[params.model] ?? 1500;
  const costCents = Math.ceil(
    (inputTokens * inputCostPerM + outputTokens * outputCostPerM) / 1_000_000,
  );

  return { content, inputTokens, outputTokens, costCents };
}
