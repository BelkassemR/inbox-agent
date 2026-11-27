import type { LLM, Message, TurnParams } from "../src/llm.ts";

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/** Replays a fixed list of turns and records what the agent sent, for precise loop tests. */
export class FakeLLM implements LLM {
  readonly name = "fake";
  readonly seen: TurnParams[] = [];
  private n = 0;
  constructor(private readonly turns: { blocks: Block[]; stop?: Message["stop_reason"] }[]) {}

  async createTurn(params: TurnParams): Promise<Message> {
    this.seen.push(structuredClone(params));
    const turn = this.turns[this.n++];
    if (!turn) throw new Error("FakeLLM ran out of turns");
    return {
      id: `msg_${this.n}`,
      type: "message",
      role: "assistant",
      model: "fake-model",
      content: turn.blocks.map((b, i) => (b.type === "tool_use" ? { ...b, id: `tu_${this.n}_${i}` } : { ...b, citations: null })),
      stop_reason: turn.stop ?? (turn.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
    } as unknown as Message;
  }
}

export const validSubmit = {
  category: "booking",
  priority: "high",
  language: "nl",
  summary: "Boekingsaanvraag.",
  extracted: { event_date: null, city: null, venue: null, organization: null, budget_eur: null, audience_size: null, event_type: null },
  draft_reply: "Hoi!",
  risk_flags: [],
};
