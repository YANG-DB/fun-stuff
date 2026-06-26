import Anthropic from "@anthropic-ai/sdk";
import { execMemory } from "./memory.js";

// Server-side Claude runner. Streams typed events and runs the tool loop:
//   - web_search / web_fetch are server-executed (no local handler) — we just
//     surface activity + collect citations.
//   - memory is client-executed — the model emits tool_use, we run it against
//     the profile's memory dir and feed the result back, looping until done.

const WEB_SEARCH = "web_search_20260209";
// Spec requested web_fetch_20260318, but this account/endpoint rejects it
// ("type does not match"); the matching dynamic-filtering generation that the
// API accepts here is web_fetch_20260209. Bump if your account gains _20260318.
const WEB_FETCH = "web_fetch_20260209";
const MEMORY = "memory_20250818";

let client = null;
export function hasAnthropicKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Run a Claude turn, yielding events:
 *   {type:"text", v}        incremental answer text
 *   {type:"thinking", v}    incremental (summarized) reasoning
 *   {type:"tool", name, q}  a tool was invoked (web_search/web_fetch/memory)
 *   {type:"sources", items} collected citations (emitted once at the end)
 * Reports token usage via onUsage.
 */
export async function* runClaude({
  model,
  systemBlocks,
  messages,
  thinking = false,
  effort = "high",
  webTools = false,
  memory = false,
  memoryDir = null,
  onUsage,
}) {
  const anthropic = getClient();

  const tools = [];
  if (webTools) {
    tools.push({ type: WEB_SEARCH, name: "web_search", max_uses: 5 });
    tools.push({ type: WEB_FETCH, name: "web_fetch", citations: { enabled: true } });
  }
  if (memory) tools.push({ type: MEMORY, name: "memory" });

  // working conversation (user/assistant turns)
  let convo = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  const citations = [];
  let lastUsage = null;

  for (let iter = 0; iter < 8; iter++) {
    const params = {
      model,
      max_tokens: 32000,
      system: systemBlocks,
      messages: convo,
      ...(tools.length ? { tools } : {}),
      ...(effort ? { output_config: { effort } } : {}),
      ...(thinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
    };

    const stream = anthropic.messages.stream(params);
    const toolBlocks = {}; // index -> { name, json } for server tools

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const b = event.content_block;
        if (b.type === "server_tool_use") {
          toolBlocks[event.index] = { name: b.name, json: "" };
        } else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          for (const r of b.content)
            if (r.type === "web_search_result") citations.push({ url: r.url, title: r.title });
        } else if (b.type === "web_fetch_tool_result" && b.content?.url) {
          citations.push({ url: b.content.url, title: b.content.content?.title || b.content.url });
        }
      } else if (event.type === "content_block_delta") {
        const d = event.delta;
        if (d.type === "text_delta") yield { type: "text", v: d.text };
        else if (d.type === "thinking_delta") yield { type: "thinking", v: d.thinking };
        else if (d.type === "input_json_delta" && toolBlocks[event.index])
          toolBlocks[event.index].json += d.partial_json || "";
      } else if (event.type === "content_block_stop" && toolBlocks[event.index]) {
        const tb = toolBlocks[event.index];
        let q = "";
        try {
          const j = JSON.parse(tb.json || "{}");
          q = j.query || j.url || "";
        } catch {
          /* ignore */
        }
        yield { type: "tool", name: tb.name, q };
        delete toolBlocks[event.index];
      }
    }

    const final = await stream.finalMessage();
    lastUsage = final.usage;

    // collect citations from the final content too (covers non-streamed paths)
    for (const blk of final.content) {
      if (blk.type === "web_search_tool_result" && Array.isArray(blk.content))
        for (const r of blk.content)
          if (r.type === "web_search_result") citations.push({ url: r.url, title: r.title });
    }

    if (final.stop_reason === "tool_use") {
      const toolUses = final.content.filter((b) => b.type === "tool_use");
      if (!toolUses.length) break;
      convo.push({ role: "assistant", content: final.content });
      const results = [];
      for (const tu of toolUses) {
        if (tu.name === "memory" && memoryDir) {
          yield { type: "tool", name: "memory", q: tu.input?.command || "" };
          const out = execMemory(memoryDir, tu.input);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: out.content,
            ...(out.is_error ? { is_error: true } : {}),
          });
        } else {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "Tool not available.",
            is_error: true,
          });
        }
      }
      convo.push({ role: "user", content: results });
      continue;
    }

    if (final.stop_reason === "pause_turn") {
      // server tool loop paused — resend to let it continue
      convo.push({ role: "assistant", content: final.content });
      continue;
    }

    break; // end_turn / max_tokens / refusal
  }

  // de-duped sources footer
  if (citations.length) {
    const seen = new Set();
    const items = [];
    for (const c of citations) {
      if (c.url && !seen.has(c.url)) {
        seen.add(c.url);
        items.push({ url: c.url, title: (c.title || c.url).replace(/[[\]]/g, "") });
      }
    }
    if (items.length) yield { type: "sources", items };
  }

  if (onUsage && lastUsage) {
    const u = lastUsage;
    onUsage({
      input:
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0,
    });
  }
}
