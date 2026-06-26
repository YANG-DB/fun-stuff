// Importers for non-Claude chat exports (ChatGPT, Gemini). Each parser reads an
// on-disk export folder and returns a list of NORMALIZED conversations:
//   { id, title, createdAt, updatedAt, summary, messages: [{ role, content, ts }] }
// importNormalized() then inserts them into a profile DB, tagging each with the
// originating engine in conversations.source so they can be labelled in the UI.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MODEL = "claude-opus-4-8";

function toEpoch(v) {
  if (typeof v === "number") return v > 1e12 ? v : Math.round(v * 1000); // sec→ms
  const t = Date.parse(v ?? "");
  return Number.isNaN(t) ? 0 : t;
}

// ---- ChatGPT (conversations-*.json; tree `mapping` per conversation) --------

function linearizeChatGpt(conv) {
  const map = conv.mapping || {};
  // Follow the active branch: walk parent links up from current_node, reverse.
  const chain = [];
  const seen = new Set();
  let nid = conv.current_node;
  while (nid && map[nid] && !seen.has(nid)) {
    seen.add(nid);
    chain.push(map[nid]);
    nid = map[nid].parent;
  }
  chain.reverse();
  let nodes = chain.length > 1 ? chain : Object.values(map);
  if (nodes === Object.values(map)) {
    nodes = [...nodes].sort(
      (a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0),
    );
  }

  const msgs = [];
  for (const node of nodes) {
    const m = node.message;
    if (!m) continue;
    const role = m.author?.role;
    if (role !== "user" && role !== "assistant") continue; // skip system/tool
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    const c = m.content;
    if (!c) continue;
    let text = "";
    if (c.content_type === "text" || c.content_type === "multimodal_text") {
      text = (c.parts || [])
        .filter((p) => typeof p === "string")
        .join("\n")
        .trim();
    }
    if (!text) continue;
    const ts = toEpoch(m.create_time || node.create_time || 0) || undefined;
    msgs.push({ role, content: text, ts });
  }
  return msgs;
}

export function parseChatGptDir(dir) {
  const files = readdirSync(dir)
    .filter((f) => /^conversations(-\d+)?\.json$/.test(f) && !f.startsWith("._"))
    .sort();
  if (!files.length) throw Object.assign(new Error("no conversations-*.json found"), { code: 404 });

  const out = [];
  for (const f of files) {
    const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const list = Array.isArray(data) ? data : data.conversations || [];
    for (const conv of list) {
      const cid = conv.conversation_id || conv.id;
      if (!cid) continue;
      const messages = linearizeChatGpt(conv);
      const created = toEpoch(conv.create_time) || Date.now();
      let updated = toEpoch(conv.update_time) || created;
      for (const m of messages) if (m.ts && m.ts > updated) updated = m.ts;
      out.push({
        id: `cg-${cid}`,
        title: String(conv.title || "ChatGPT chat").slice(0, 120),
        createdAt: created,
        updatedAt: updated,
        summary: "",
        messages,
      });
    }
  }
  return out;
}

// ---- Gemini (Takeout: per-conversation .txt files holding JSON) -------------

function findGeminiFiles(dir) {
  const found = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith("._")) continue;
      const p = join(d, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/^conversation_.*\.txt$/.test(name)) found.push(p);
    }
  };
  walk(dir);
  return found.sort();
}

function parseGeminiFile(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const turns = json.conversation_turns || [];
  const messages = [];
  for (const t of turns) {
    if (t.user_turn) {
      const text = String(t.user_turn.prompt || "").trim();
      if (text) messages.push({ role: "user", content: text, ts: toEpoch(t.user_turn.turn_last_modified) || undefined });
    } else if (t.system_turn) {
      const text = (t.system_turn.text || []).map((x) => x.data || "").join("\n").trim();
      if (text) messages.push({ role: "assistant", content: text, ts: toEpoch(t.system_turn.turn_last_modified) || undefined });
    }
  }
  const m = path.match(/conversation_([^/.]+)\.txt$/);
  const fid = m ? m[1] : String(json.creation_time || Math.abs(hash(path)));
  const created = toEpoch(json.creation_time) || Date.now();
  let updated = toEpoch(json.last_modification_time) || created;
  for (const x of messages) if (x.ts && x.ts > updated) updated = x.ts;
  return {
    id: `gm-${fid}`,
    title: String(json.title || "Gemini chat").slice(0, 120),
    createdAt: created,
    updatedAt: updated,
    summary: "",
    messages,
  };
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export function parseGeminiDir(dir) {
  const files = findGeminiFiles(dir);
  if (!files.length) throw Object.assign(new Error("no conversation_*.txt found"), { code: 404 });
  const out = [];
  for (const f of files) {
    try {
      out.push(parseGeminiFile(f));
    } catch {
      /* skip malformed file */
    }
  }
  return out;
}

// ---- shared inserter --------------------------------------------------------

/**
 * Insert normalized conversations into a profile DB, tagging conversations.source.
 * Dedupes by id so re-importing is safe. Returns counts + items (for triage).
 */
export function importNormalized(db, source, convs, onlyIds = null) {
  const existing = db.prepare("SELECT id FROM conversations WHERE id = ?");
  const insConv = db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, model, concepts, pinned, source)
    VALUES (?, ?, ?, ?, ?, '[]', 0, ?)
  `);
  const insMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, ts, model, context_used, seq)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `);

  let imported = 0;
  let skipped = 0;
  let messages = 0;
  const items = [];

  for (const conv of convs) {
    const cid = conv.id;
    if (!cid) {
      skipped++;
      continue;
    }
    if (onlyIds && !onlyIds.has(cid)) continue;
    if (existing.get(cid)) {
      skipped++;
      continue;
    }
    if (!conv.messages?.length) {
      skipped++;
      continue;
    }
    insConv.run(cid, conv.title || "Imported chat", conv.createdAt, conv.updatedAt, DEFAULT_MODEL, source);
    conv.messages.forEach((m, i) => {
      insMsg.run(`${cid}-m${i}`, cid, m.role, m.content, m.ts || conv.createdAt, DEFAULT_MODEL, i);
      messages++;
    });
    imported++;
    items.push({ id: cid, title: conv.title, summary: conv.summary || "" });
  }
  return { imported, skipped, messages, items };
}

export function parseEngineDir(engine, dir) {
  if (engine === "chatgpt") return parseChatGptDir(dir);
  if (engine === "gemini") return parseGeminiDir(dir);
  throw Object.assign(new Error(`unknown engine: ${engine}`), { code: 400 });
}
