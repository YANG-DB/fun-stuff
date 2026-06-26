// Import a Claude.ai data export ("conversations.json") into a profile's DB to
// bootstrap history. The export is an array of conversations; each has a name,
// timestamps, and a chat_messages array. We map them onto our schema and dedupe
// by the original Claude uuid so re-importing is safe.

const DEFAULT_MODEL = "claude-opus-4-8";

function toEpoch(v) {
  if (typeof v === "number") return v;
  const t = Date.parse(v ?? "");
  return Number.isNaN(t) ? Date.now() : t;
}

/** Extract message text from either `text` or a `content` block array. */
function messageText(m) {
  if (typeof m.text === "string" && m.text.trim()) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b) => b.text || "")
      .join("")
      .trim();
  }
  return "";
}

function mapRole(sender) {
  return sender === "assistant" ? "assistant" : "user";
}

/** Accepts the parsed export (array) or {conversations:[...]}; returns the list. */
function asConversationList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.conversations)) return data.conversations;
  return null;
}

/**
 * Import into an open profile DB. Returns counts.
 * @returns {{imported:number, skipped:number, messages:number}}
 */
export function importClaudeExport(db, data, onlyIds = null) {
  const list = asConversationList(data);
  if (!list) throw new Error("Unrecognized export format (expected conversations.json array)");

  const existing = db.prepare("SELECT id FROM conversations WHERE id = ?");
  const insConv = db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, model, concepts, pinned)
    VALUES (?, ?, ?, ?, ?, '[]', 0)
  `);
  const insMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, ts, model, context_used, seq)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `);

  let imported = 0;
  let skipped = 0;
  let messages = 0;
  const items = []; // { id, title, summary } for newly imported conversations

  for (const conv of list) {
    const cid = conv.uuid || conv.id;
    if (!cid) {
      skipped++;
      continue;
    }
    if (onlyIds && !onlyIds.has(cid)) continue; // not selected for this profile
    if (existing.get(cid)) {
      skipped++; // already imported
      continue;
    }

    const rawMsgs = conv.chat_messages || conv.messages || [];
    const created = toEpoch(conv.created_at);
    let updated = toEpoch(conv.updated_at);

    const prepared = [];
    rawMsgs.forEach((m, i) => {
      const text = messageText(m);
      if (!text) return;
      const ts = toEpoch(m.created_at) || created;
      if (ts > updated) updated = ts;
      prepared.push({
        id: m.uuid || m.id || `m-${cid}-${i}`,
        role: mapRole(m.sender ?? m.role),
        content: text,
        ts,
        seq: i,
      });
    });

    insConv.run(
      cid,
      (conv.name || conv.title || "Imported chat").slice(0, 120) || "Imported chat",
      created,
      updated,
      DEFAULT_MODEL,
    );
    for (const p of prepared) {
      insMsg.run(p.id, cid, p.role, p.content, p.ts, DEFAULT_MODEL, p.seq);
      messages++;
    }
    imported++;
    items.push({
      id: cid,
      title: (conv.name || conv.title || "Imported chat").slice(0, 120),
      summary: String(conv.summary || "").trim(),
    });
  }

  return { imported, skipped, messages, items };
}
