import type { Config } from "@inbox/core";
import { AnthropicLLM, type LLM } from "./llm.ts";
import { ScriptedLLM } from "./scripted/scripted-llm.ts";

export function createLLM(config: Pick<Config, "LLM_PROVIDER" | "ANTHROPIC_API_KEY" | "AGENT_MODEL" | "AGENT_EFFORT">): LLM {
  if (config.LLM_PROVIDER === "anthropic") {
    return new AnthropicLLM({ apiKey: config.ANTHROPIC_API_KEY || undefined, model: config.AGENT_MODEL, effort: config.AGENT_EFFORT });
  }
  return new ScriptedLLM();
}

export const DEFAULT_BUSINESS = { artistName: process.env.ARTIST_NAME ?? "NOVA", teamLanguage: "Dutch" };
