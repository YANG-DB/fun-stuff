import type { ContextChip, Conversation, Message, ModelId, Profile, Note, MemoryEntry } from "../types";

// Gateway-ready chat client. The backend streams newline-delimited JSON events
// (text / thinking / tool / sources / done); we parse them into typed events.
// Falls back to a local mock when the backend is unreachable.

const USE_BACKEND = import.meta.env.VITE_USE_BACKEND !== "0";

export interface ChatRequest {
  profile: Profile;
  model: ModelId;
  messages: Message[];
  contextChips: ContextChip[];
  conversationId?: string;
  assistantMessageId?: string;
}

export type ChatEvent =
  | { type: "text"; v: string }
  | { type: "thinking"; v: string }
  | { type: "tool"; name: string; q?: string }
  | { type: "sources"; items: { url: string; title: string }[] }
  | { type: "done" };

// Build the API content for a message: a plain string, or — when images are
// attached — an array of Anthropic content blocks (text + image).
function toContent(m: Message): unknown {
  if (!m.images || m.images.length === 0) return m.content;
  const blocks: unknown[] = [];
  for (const url of m.images) {
    const match = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (!match) continue;
    blocks.push({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } });
  }
  if (m.content) blocks.push({ type: "text", text: m.content });
  return blocks.length ? blocks : m.content;
}

export async function* streamChat(
  req: ChatRequest,
): AsyncGenerator<ChatEvent, void, unknown> {
  if (USE_BACKEND) {
    try {
      yield* streamFromBackend(req);
      return;
    } catch {
      yield { type: "text", v: "_(gateway unavailable — local mock reply)_\n\n" };
      yield* streamMock(req);
      return;
    }
  }
  yield* streamMock(req);
}

async function* streamFromBackend(
  req: ChatRequest,
): AsyncGenerator<ChatEvent, void, unknown> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(localStorage.getItem("personal-claude:session")
        ? { Authorization: `Bearer ${localStorage.getItem("personal-claude:session")}` }
        : {}),
    },
    body: JSON.stringify({
      profileId: req.profile.id,
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: toContent(m) })),
      context: req.contextChips.filter((c) => c.kept).map((c) => ({ type: c.kind, id: c.sourceSessionId })),
      conversationId: req.conversationId,
      messageId: req.assistantMessageId,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`Gateway error: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        yield JSON.parse(t) as ChatEvent;
      } catch {
        // tolerate a non-JSON chunk by surfacing it as text
        yield { type: "text", v: t };
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim()) as ChatEvent;
    } catch {
      /* ignore trailing partial */
    }
  }
}

// --- Mock implementation ---------------------------------------------------

function mockReply(req: ChatRequest): string {
  const last = req.messages[req.messages.length - 1]?.content.toLowerCase() ?? "";
  if (last.includes("hello") || last.startsWith("hi"))
    return `Hi ${req.profile.name}! Running as **${req.model}**. What are we working on?`;
  return "Here's how I'd think about that. *(local mock — wire the gateway for real replies.)*";
}

async function* streamMock(
  req: ChatRequest,
): AsyncGenerator<ChatEvent, void, unknown> {
  for (const tok of mockReply(req).split(/(\s+)/)) {
    await new Promise((r) => setTimeout(r, 16));
    yield { type: "text", v: tok };
  }
}

// Type-ahead retrieval: as the user drafts a message, find the most relevant
// past conversations, notes and saved memory (by title / topics / summary /
// body) to suggest as aligning context. Returns suggestions (kept:false) the
// user can add with one click.
interface Cand {
  kind: ContextChip["kind"];
  id: string;
  title: string;
  strong: string; // high-weight text (title/subject/concepts)
  weak: string; // low-weight text (summary/body)
  recency: number;
  snippet: string;
}
export function retrieveContext(
  draft: string,
  profileId: string,
  conversations: Conversation[],
  currentConversationId: string,
  notes: Note[] = [],
  memory: MemoryEntry[] = [],
): ContextChip[] {
  const words = [...new Set(draft.toLowerCase().split(/\W+/).filter((w) => w.length > 3))];
  if (words.length === 0) return [];

  const cands: Cand[] = [];
  for (const c of conversations) {
    if (c.profileId !== profileId || c.id === currentConversationId || c.deleted || c.messages.length === 0) continue;
    cands.push({
      kind: "conversation",
      id: c.id,
      title: c.title,
      strong: `${c.title} ${c.concepts.join(" ")}`.toLowerCase(),
      weak: (c.summary || "").toLowerCase(),
      recency: c.updatedAt,
      snippet: (c.summary || "").replace(/[#*`]/g, "").slice(0, 110),
    });
  }
  for (const n of notes) {
    if (n.profileId !== profileId) continue;
    cands.push({
      kind: "note",
      id: n.id,
      title: n.title || "Note",
      strong: (n.title || "").toLowerCase(),
      weak: (n.body || "").toLowerCase(),
      recency: n.updatedAt,
      snippet: (n.body || "").replace(/[#*`]/g, "").slice(0, 110),
    });
  }
  for (const m of memory) {
    if (m.profileId !== profileId) continue;
    cands.push({
      kind: "memory",
      id: m.id,
      title: m.subject || "Memory",
      strong: (m.subject || "").toLowerCase(),
      weak: (m.body || "").toLowerCase(),
      recency: m.createdAt,
      snippet: (m.body || "").replace(/[#*`]/g, "").slice(0, 110),
    });
  }

  return cands
    .map((c) => {
      let score = 0;
      const hits: string[] = [];
      for (const w of words) {
        if (c.strong.includes(w)) {
          score += 3;
          hits.push(w);
        } else if (c.weak.includes(w)) {
          score += 1;
          hits.push(w);
        }
      }
      return { c, score, hits: [...new Set(hits)] };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.c.recency - a.c.recency)
    .slice(0, 6)
    .map(({ c, hits }) => ({
      id: `${c.kind}-${c.id}`,
      sourceSessionId: c.id,
      kind: c.kind,
      sourceTitle: c.title,
      reason: `${c.kind} · ${hits.slice(0, 3).join(", ")}`,
      snippet: c.snippet,
      kept: false,
    }));
}
