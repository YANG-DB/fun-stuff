// Export a profile's memory + workspace data to markdown files (downloaded
// client-side from data already in the store).
import type { Note, Reminder, MemoryEntry, Conversation } from "../types";

export function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const fmtDate = (ts: number) => new Date(ts).toLocaleDateString();
const fmtDateTime = (ts: number) => new Date(ts).toLocaleString();

export function notesMd(notes: Note[]): string {
  if (!notes.length) return "# Notes\n\n_(none)_\n";
  return (
    "# Notes\n\n" +
    notes
      .map((n) => `## ${n.title || "Untitled"}\n\n${n.body}\n\n_${fmtDateTime(n.updatedAt)}_`)
      .join("\n\n---\n\n") +
    "\n"
  );
}

export function remindersMd(reminders: Reminder[]): string {
  if (!reminders.length) return "# Reminders\n\n_(none)_\n";
  const sorted = [...reminders].sort((a, b) => a.dueAt - b.dueAt);
  return (
    "# Reminders\n\n" +
    sorted
      .map((r) => `- [${r.done ? "x" : " "}] ${r.text} — due ${fmtDate(r.dueAt)}`)
      .join("\n") +
    "\n"
  );
}

export function memoryMd(memory: MemoryEntry[]): string {
  if (!memory.length) return "# Saved memory\n\n_(none)_\n";
  return (
    "# Saved memory\n\n" +
    memory
      .map((m) => `## ${m.subject}\n\n${m.body}\n\n_${fmtDateTime(m.createdAt)}_`)
      .join("\n\n---\n\n") +
    "\n"
  );
}

export function ltmMd(ltm: string): string {
  return `# Long-term memory (LTM)\n\n${ltm.trim() || "_(empty)_"}\n`;
}

export function stmMd(stm: string): string {
  return `# Short-term memory (STM)\n\n${stm.trim() || "_(empty)_"}\n`;
}

export interface ExportBundle {
  profileName: string;
  ltm: string;
  stm: string;
  notes: Note[];
  reminders: Reminder[];
  memory: MemoryEntry[];
}

// ---- single-conversation export (JSON / Markdown / PDF) --------------------

const SRC_NAME: Record<string, string> = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini" };
const safeName = (s: string) => (s || "conversation").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60) || "conversation";

export function conversationJson(c: Conversation): string {
  return JSON.stringify(
    {
      id: c.id,
      title: c.title,
      source: c.source || "claude",
      model: c.model,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      summary: c.summary,
      concepts: c.concepts,
      messages: c.messages.map((m) => ({ role: m.role, content: m.content, ts: m.ts, model: m.model })),
    },
    null,
    2,
  );
}

export function conversationMd(c: Conversation): string {
  const head = [
    `# ${c.title}`,
    `_${SRC_NAME[c.source || "claude"] || "Claude"} · ${fmtDateTime(c.updatedAt)} · ${c.messages.length} messages_`,
  ];
  if (c.summary) head.push(`\n> ${c.summary.replace(/\n+/g, " ")}`);
  if (c.concepts.length) head.push(`\n**Topics:** ${c.concepts.join(", ")}`);
  const body = c.messages.map((m) => {
    const who = m.role === "assistant" ? "🤖 Assistant" : "🧑 You";
    return `### ${who}\n${m.content}`;
  });
  return head.join("\n") + "\n\n---\n\n" + body.join("\n\n---\n\n") + "\n";
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Open a printable window for the conversation and trigger the browser's
// print dialog (→ "Save as PDF"). No external dependency needed.
export function printConversation(c: Conversation) {
  const rows = c.messages
    .map(
      (m) =>
        `<div class="m ${m.role}"><div class="who">${m.role === "assistant" ? "Assistant" : "You"}</div><div class="c">${esc(m.content)}</div></div>`,
    )
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(c.title)}</title>
<style>
  body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 20px;}
  h1{font-size:22px;margin:0 0 4px;}
  .meta{color:#666;font-size:12px;margin-bottom:6px;}
  .summary{background:#f5f3ff;border-left:3px solid #7c6ff0;padding:8px 12px;border-radius:6px;margin:10px 0;font-size:13px;}
  .m{margin:14px 0;padding-bottom:14px;border-bottom:1px solid #eee;}
  .who{font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#888;margin-bottom:4px;}
  .m.assistant .who{color:#d9772f;}
  .c{white-space:pre-wrap;}
  @media print{body{margin:0;}}
</style></head><body>
  <h1>${esc(c.title)}</h1>
  <div class="meta">${SRC_NAME[c.source || "claude"] || "Claude"} · ${fmtDateTime(c.updatedAt)} · ${c.messages.length} messages</div>
  ${c.summary ? `<div class="summary">${esc(c.summary)}</div>` : ""}
  ${rows}
  <script>window.onload=function(){setTimeout(function(){window.print();},250);};</script>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

export function exportConversation(c: Conversation, fmt: "json" | "md" | "pdf") {
  if (fmt === "pdf") return printConversation(c);
  if (fmt === "json") return downloadText(`${safeName(c.title)}.json`, conversationJson(c));
  return downloadText(`${safeName(c.title)}.md`, conversationMd(c));
}

export function combinedMd(b: ExportBundle): string {
  return [
    `# ${b.profileName} — workspace export`,
    `_Generated ${new Date().toLocaleString()}_`,
    ltmMd(b.ltm),
    stmMd(b.stm),
    memoryMd(b.memory),
    notesMd(b.notes),
    remindersMd(b.reminders),
  ].join("\n\n");
}
