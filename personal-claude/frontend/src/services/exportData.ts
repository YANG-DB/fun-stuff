// Export a profile's memory + workspace data to markdown files (downloaded
// client-side from data already in the store).
import type { Note, Reminder, MemoryEntry, Conversation } from "../types";
import type { ProfileDetails } from "./api";

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

// ---- full-profile export (JSON / Markdown / PDF) ---------------------------

export interface ProfileExport {
  name: string;
  tagline?: string;
  persona?: string;
  model?: string;
  google?: { email: string; name: string } | null;
  allowedEmails?: string[];
  budgetUsd?: number;
  spentUsd?: number;
  tokens?: number;
  details: ProfileDetails;
  context: string;
  ltm: string;
  stm: string;
  notes: Note[];
  reminders: Reminder[];
  memory: MemoryEntry[];
  conversations: { title: string; source?: string; summary?: string; concepts: string[]; updatedAt: number; messages: number }[];
}

function detailsMd(d: ProfileDetails): string {
  const L: string[] = [];
  if (d.name) L.push(`- **Name:** ${d.name}`);
  if (d.location) L.push(`- **Location:** ${d.location}`);
  if (d.role) L.push(`- **Role:** ${d.role}`);
  if (d.bio) L.push(`- **About:** ${d.bio}`);
  if (d.websites?.length) L.push(`- **Websites:** ${d.websites.filter(Boolean).join(", ")}`);
  for (const s of d.socials || []) if (s.url || s.label) L.push(`- **${s.label || "Social"}:** ${s.url}`);
  for (const c of d.custom || []) if (c.label && c.value) L.push(`- **${c.label}:** ${c.value}`);
  return L.length ? L.join("\n") : "_(none)_";
}

function convosMd(list: ProfileExport["conversations"]): string {
  if (!list.length) return "# Conversations\n\n_(none)_\n";
  const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    "# Conversations\n\n" +
    sorted
      .map((c) => {
        const tags = c.concepts?.length ? ` · _${c.concepts.join(", ")}_` : "";
        const src = c.source ? `[${c.source}] ` : "";
        return `- **${src}${c.title}** — ${c.messages} msgs · ${fmtDate(c.updatedAt)}${tags}${c.summary ? `\n  ${c.summary.replace(/\n+/g, " ")}` : ""}`;
      })
      .join("\n") +
    "\n"
  );
}

export function profileJson(p: ProfileExport): string {
  return JSON.stringify(p, null, 2);
}

export function profileMd(p: ProfileExport): string {
  const head = [
    `# ${p.name} — profile export`,
    `_Generated ${new Date().toLocaleString()}_`,
    "",
    `- **Model:** ${p.model || "—"}`,
    p.google ? `- **Google:** ${p.google.name} (${p.google.email})` : "",
    p.allowedEmails?.length ? `- **Access:** ${p.allowedEmails.join(", ")}` : "",
    typeof p.spentUsd === "number" ? `- **Spend:** $${p.spentUsd.toFixed(2)} / $${p.budgetUsd}` : "",
    typeof p.tokens === "number" ? `- **Tokens:** ${p.tokens}` : "",
    p.tagline ? `- **Tagline:** ${p.tagline}` : "",
  ].filter(Boolean).join("\n");
  return [
    head,
    `## Personal details\n\n${detailsMd(p.details)}`,
    `## User context\n\n${p.context.trim() || "_(none)_"}`,
    ltmMd(p.ltm),
    stmMd(p.stm),
    memoryMd(p.memory),
    notesMd(p.notes),
    remindersMd(p.reminders),
    convosMd(p.conversations),
    p.persona ? `## Persona\n\n${p.persona}` : "",
  ].filter(Boolean).join("\n\n");
}

export function printProfile(p: ProfileExport) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.name)} — profile</title>
<style>
  body{font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:760px;margin:32px auto;padding:0 20px;}
  h1{font-size:22px;margin:0 0 4px;} h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #eee;padding-bottom:3px;}
  .meta{color:#666;font-size:12px;} pre,.body{white-space:pre-wrap;font:inherit;}
</style></head><body>
  <h1>${esc(p.name)}</h1>
  <div class="meta">profile export · ${new Date().toLocaleString()}</div>
  <div class="body">${esc(profileMd(p).replace(/^# .*\n/, ""))}</div>
  <script>window.onload=function(){setTimeout(function(){window.print();},250);};</script>
</body></html>`;
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

export function exportProfile(p: ProfileExport, fmt: "json" | "md" | "pdf") {
  if (fmt === "pdf") return printProfile(p);
  if (fmt === "json") return downloadText(`${safeName(p.name)}-profile.json`, profileJson(p));
  return downloadText(`${safeName(p.name)}-profile.md`, profileMd(p));
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
