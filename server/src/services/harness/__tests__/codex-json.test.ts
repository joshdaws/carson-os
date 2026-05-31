/**
 * Tests for CodexEventMapper — mapping `codex exec --json` events to
 * HarnessEvents. Uses the real event lines captured from the 0.130.0 spike.
 */

import { describe, it, expect } from "vitest";
import type { HarnessEvent } from "@carsonos/shared";
import { CodexEventMapper } from "../codex-json.js";

// Real lines captured from `codex exec --json` during the security spike.
const SPIKE_LINES = [
  `{"type":"thread.started","thread_id":"019e5af2-fb3a-7d61-81be-65fd34f323db"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"spike_echo","tool":"spike_echo","arguments":{"message":"hi"},"result":null,"error":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"spike_echo","tool":"spike_echo","arguments":{"message":"hi"},"result":{"content":[{"type":"text","text":"ECHO: hi"}],"structured_content":null},"error":null,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"DONE"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":51227,"cached_input_tokens":35968,"output_tokens":169,"reasoning_output_tokens":57}}`,
];

function mapAll(lines: string[]): { events: HarnessEvent[]; mapper: CodexEventMapper } {
  const mapper = new CodexEventMapper();
  const events: HarnessEvent[] = [];
  for (const line of lines) events.push(...mapper.handleLine(line));
  return { events, mapper };
}

describe("CodexEventMapper", () => {
  it("maps a full spike turn (thread, tool call, message, usage)", () => {
    const { events, mapper } = mapAll(SPIKE_LINES);

    // thread_id is captured (not streamed) — the harness emits session_id only
    // on success, so an aborted turn never persists a thread_id.
    expect(events).toEqual<HarnessEvent[]>([
      { type: "tool_use_start", name: "spike_echo", input: { message: "hi" }, id: "item_1" },
      { type: "tool_use_end", name: "spike_echo", result: "ECHO: hi", isError: false, id: "item_1" },
      { type: "text_delta", text: "DONE" },
      { type: "usage", inputTokens: 51227, outputTokens: 169 },
    ]);
    expect(mapper.capturedThreadId).toBe("019e5af2-fb3a-7d61-81be-65fd34f323db");
    expect(mapper.sawTurnCompleted).toBe(true);
    expect(mapper.content).toBe("DONE");
  });

  it("accumulates multiple agent_message items into content joined by blank lines", () => {
    const { mapper } = mapAll([
      `{"type":"item.completed","item":{"type":"agent_message","text":"first"}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"second"}}`,
    ]);
    expect(mapper.content).toBe("first\n\nsecond");
  });

  it("streams a paragraph break before each agent_message after the first", () => {
    // Regression: post-v0.6.0 the live Telegram stream glued consecutive Codex
    // agent_message blocks together (e.g. "…anything.Checked.") because the
    // streamed text_delta carried no separator, while the final `content` joins
    // blocks with "\n\n". The streamed deltas must reconstruct `content` exactly.
    const { events, mapper } = mapAll([
      `{"type":"item.completed","item":{"type":"agent_message","text":"anything."}}`,
      `{"type":"item.completed","item":{"type":"agent_message","text":"Checked."}}`,
    ]);

    const textDeltas = events
      .filter((e): e is Extract<HarnessEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.text);

    // First block has no leading separator; every later block carries "\n\n".
    expect(textDeltas).toEqual(["anything.", "\n\nChecked."]);
    // The streamed concatenation must equal the final content exactly.
    expect(textDeltas.join("")).toBe(mapper.content);
  });

  it("flags a failed tool call as isError", () => {
    const m = new CodexEventMapper();
    const events = m.handleLine(
      `{"type":"item.completed","item":{"id":"x","type":"mcp_tool_call","tool":"t","result":null,"error":{"message":"user cancelled MCP tool call"},"status":"failed"}}`,
    );
    expect(events).toEqual<HarnessEvent[]>([
      { type: "tool_use_end", name: "t", isError: true, id: "x" },
    ]);
  });

  it("ignores turn.started, reasoning, and unknown event types", () => {
    const m = new CodexEventMapper();
    expect(m.handleLine(`{"type":"turn.started"}`)).toEqual([]);
    expect(m.handleLine(`{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}`)).toEqual([]);
    expect(m.handleLine(`{"type":"some.future.event"}`)).toEqual([]);
  });

  it("tolerates malformed JSON and blank lines", () => {
    const m = new CodexEventMapper();
    expect(m.handleLine("")).toEqual([]);
    expect(m.handleLine("   ")).toEqual([]);
    expect(m.handleLine("not json {")).toEqual([]);
    expect(m.sawTurnCompleted).toBe(false);
  });

  it("emits usage even when token fields are partial", () => {
    const m = new CodexEventMapper();
    expect(m.handleLine(`{"type":"turn.completed","usage":{"output_tokens":5}}`)).toEqual([
      { type: "usage", outputTokens: 5 },
    ]);
  });
});
