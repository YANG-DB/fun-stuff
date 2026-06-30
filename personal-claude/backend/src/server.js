import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import dotenv from "dotenv";
import express from "express";
import {
  systemDb,
  getProfileDb,
  profileExists,
  deleteProfileDb,
  writeProfilesMd,
  DATA_PATHS,
} from "./db.js";
import { hasGeminiKey, streamGemini } from "./gemini.js";
import { hasAnthropicKey, runClaude } from "./anthropic.js";
import { importClaudeExport } from "./claudeImport.js";
import { parseEngineDir, importNormalized } from "./engineImport.js";
import * as gws from "./gworkspace.js";
import { buildSystem } from "./systemPrompt.js";
import { readContext, writeContext } from "./contextStore.js";
import { memoryDir } from "./memory.js";
import { readMemFile, writeMemFile, writeDigest, writeConvMeta, readDetails, writeDetails, STM_FILE, LTM_FILE } from "./memoryFiles.js";
import {
  authConfigured,
  verifyGoogleCredential,
  issueSession,
  verifySession,
} from "./auth.js";

// Load the shared .env (personal-claude/.env) for the server-side keys.
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", "..", ".env") });

const app = express();
// Generous limit so a full Claude conversations.json export fits in one POST.
app.use(express.json({ limit: "100mb" }));

const uid = (p) => `${p}-${Math.random().toString(36).slice(2, 9)}`;

// --- row -> API object mappers --------------------------------------------

function mapProfile(row, chatCount, tokens) {
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline,
    persona: row.persona,
    avatar: row.avatar,
    color: row.color,
    defaultModel: row.default_model,
    budgetUsd: row.budget_usd,
    spentUsd: row.spent_usd,
    google: row.google ? JSON.parse(row.google) : undefined,
    allowedEmails: parseEmails(row.allowed_emails),
    settings: parseSettings(row.settings),
    chatCount,
    tokens: tokens ?? 0,
  };
}

const DEFAULT_SETTINGS = {
  thinking: false,
  effort: "high",
  webTools: true,
  memory: false,
};
function parseSettings(raw) {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw || "{}") || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function parseEmails(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** A profile with an empty allow-list is open to any signed-in user. */
function emailCanAccess(profileRow, email) {
  const list = parseEmails(profileRow.allowed_emails).map((e) =>
    String(e).toLowerCase(),
  );
  if (!list.length) return true;
  return email ? list.includes(email.toLowerCase()) : false;
}
function mapMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    ts: row.ts,
    model: row.model ?? undefined,
    images: row.images ? JSON.parse(row.images) : undefined,
    contextUsed: row.context_used ? JSON.parse(row.context_used) : undefined,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
  };
}
function mapConversation(row, profileId, messages, tokens) {
  return {
    id: row.id,
    profileId,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    model: row.model,
    concepts: JSON.parse(row.concepts || "[]"),
    pinned: !!row.pinned,
    summary: row.summary || undefined,
    subject: row.subject || undefined,
    source: row.source || "claude",
    deleted: !!row.deleted,
    // (conversation source, distinct from reminder.source below)
    messages: messages ?? [],
    tokens: tokens ?? 0,
  };
}
function mapNote(row, profileId) {
  return {
    id: row.id,
    profileId,
    conversationId: row.conversation_id ?? undefined,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function mapReminder(row, profileId) {
  return {
    id: row.id,
    profileId,
    text: row.text,
    dueAt: row.due_at,
    done: !!row.done,
    repeat: row.repeat || "none",
    source: row.source || "manual",
    conversationId: row.conversation_id ?? undefined,
  };
}

// Resolve + validate :pid into an open profile DB, enforcing access.
function withProfile(req, res, next) {
  const { pid } = req.params;
  const prow = systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(pid);
  if (!prow) return res.status(404).json({ error: "no such profile" });
  if (!emailCanAccess(prow, req.user?.email)) {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    req.db = getProfileDb(pid);
    req.pid = pid;
    next();
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}

// --- auth: login gate -----------------------------------------------------

// Public: lets the client know whether sign-in is required before it has a token.
app.get("/api/auth/config", (_req, res) => {
  res.json({ authRequired: authConfigured() });
});

// Public: exchange a Google ID token for a session token.
app.post("/api/auth/google", async (req, res) => {
  if (!authConfigured()) {
    return res.status(400).json({ error: "auth not configured on server" });
  }
  try {
    const user = await verifyGoogleCredential(req.body.credential);
    res.json({ token: issueSession(user), user });
  } catch (e) {
    res.status(401).json({ error: `Google verification failed: ${e.message}` });
  }
});

// Everything below requires a valid session (when auth is configured).
app.use("/api", (req, res, next) => {
  if (!authConfigured()) {
    req.user = null; // open mode (no keys) — don't lock anyone out
    return next();
  }
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  const user = token ? verifySession(token) : null;
  if (!user) return res.status(401).json({ error: "unauthenticated" });
  req.user = user;
  next();
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.user, authRequired: authConfigured() });
});

// --- profiles --------------------------------------------------------------

app.get("/api/profiles", (req, res) => {
  const rows = systemDb
    .prepare("SELECT * FROM profiles ORDER BY rowid")
    .all()
    .filter((r) => emailCanAccess(r, req.user?.email));
  const out = rows.map((r) => {
    const db = getProfileDb(r.id);
    const n = db.prepare("SELECT COUNT(*) n FROM conversations WHERE deleted=0").get().n;
    const t = db
      .prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) t FROM messages")
      .get().t;
    return mapProfile(r, n, t);
  });
  res.json(out);
});

// Create a new profile (any signed-in user may add one).
app.post("/api/profiles", (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });

  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 20) || "profile";
  const id = `p-${slug}-${Math.random().toString(36).slice(2, 7)}`;

  const emails = Array.isArray(b.allowedEmails)
    ? b.allowedEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
    : [];

  systemDb
    .prepare(
      `INSERT INTO profiles
        (id, name, tagline, persona, avatar, color, default_model, budget_usd, spent_usd, google, allowed_emails)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    )
    .run(
      id,
      name,
      String(b.tagline || ""),
      String(b.persona || ""),
      String(b.avatar || "🧑"),
      String(b.color || "#7C6FF0"),
      String(b.defaultModel || "claude-opus-4-8"),
      Number(b.budgetUsd) || 0,
      JSON.stringify(emails),
    );
  getProfileDb(id); // provision the per-profile DB file now
  writeProfilesMd();
  const row = systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(id);
  res.status(201).json(mapProfile(row, 0, 0));
});

// Delete a profile and all its data (gated by access).
app.delete("/api/profiles/:pid", (req, res) => {
  const prow = systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(req.params.pid);
  if (!prow) return res.status(404).json({ error: "no such profile" });
  if (!emailCanAccess(prow, req.user?.email))
    return res.status(403).json({ error: "forbidden" });
  systemDb.prepare("DELETE FROM profiles WHERE id=?").run(req.params.pid);
  deleteProfileDb(req.params.pid);
  writeProfilesMd();
  res.json({ ok: true });
});

app.patch("/api/profiles/:pid", (req, res) => {
  const prow = systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(req.params.pid);
  if (!prow) return res.status(404).json({ error: "no such profile" });
  if (!emailCanAccess(prow, req.user?.email))
    return res.status(403).json({ error: "forbidden" });
  const allowed = {
    persona: "persona",
    defaultModel: "default_model",
    budgetUsd: "budget_usd",
    spentUsd: "spent_usd",
    name: "name",
    tagline: "tagline",
    avatar: "avatar",
    color: "color",
  };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (k in req.body) {
      sets.push(`${col}=?`);
      vals.push(req.body[k]);
    }
  }
  if ("google" in req.body) {
    sets.push("google=?");
    vals.push(req.body.google ? JSON.stringify(req.body.google) : null);
  }
  if ("allowedEmails" in req.body) {
    const emails = Array.isArray(req.body.allowedEmails)
      ? req.body.allowedEmails
          .map((e) => String(e).trim().toLowerCase())
          .filter(Boolean)
      : [];
    sets.push("allowed_emails=?");
    vals.push(JSON.stringify(emails));
  }
  if ("settings" in req.body) {
    const merged = parseSettings(prow.settings);
    Object.assign(merged, req.body.settings || {});
    sets.push("settings=?");
    vals.push(JSON.stringify(merged));
  }
  if (sets.length) {
    vals.push(req.params.pid);
    systemDb.prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE id=?`).run(...vals);
    writeProfilesMd();
  }
  const row = systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(req.params.pid);
  const pdb = getProfileDb(req.params.pid);
  const n = pdb.prepare("SELECT COUNT(*) n FROM conversations WHERE deleted=0").get().n;
  const t = pdb
    .prepare("SELECT COALESCE(SUM(input_tokens + output_tokens), 0) t FROM messages")
    .get().t;
  res.json(mapProfile(row, n, t));
});

// --- per-profile user_context (curated context for the system prompt) ------

app.get("/api/profiles/:pid/context", withProfile, (req, res) => {
  res.json({ content: readContext(req.pid) });
});
app.put("/api/profiles/:pid/context", withProfile, (req, res) => {
  writeContext(req.pid, req.body?.content ?? "");
  res.json({ ok: true });
});

// --- conversations + messages ---------------------------------------------

app.get("/api/profiles/:pid/conversations", withProfile, (req, res) => {
  const convs = req.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all();
  const msgStmt = req.db.prepare(
    "SELECT * FROM messages WHERE conversation_id=? ORDER BY ts, seq",
  );
  res.json(
    convs.map((c) => {
      const msgs = msgStmt.all(c.id).map(mapMessage);
      const tokens = msgs.reduce(
        (s, m) => s + (m.inputTokens || 0) + (m.outputTokens || 0),
        0,
      );
      return mapConversation(c, req.pid, msgs, tokens);
    }),
  );
});

app.post("/api/profiles/:pid/conversations", withProfile, (req, res) => {
  const now = Date.now();
  const id = uid("c");
  const model = req.body.model || "claude-opus-4-8";
  req.db
    .prepare(
      "INSERT INTO conversations (id, title, created_at, updated_at, model, concepts, pinned) VALUES (?,?,?,?,?,?,0)",
    )
    .run(id, "New chat", now, now, model, "[]");
  const row = req.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
  res.status(201).json(mapConversation(row, req.pid, []));
});

app.patch("/api/profiles/:pid/conversations/:cid", withProfile, (req, res) => {
  const { cid } = req.params;
  const fields = { title: "title", pinned: "pinned", model: "model", deleted: "deleted" };
  const sets = ["updated_at=?"];
  const vals = [Date.now()];
  for (const [k, col] of Object.entries(fields)) {
    if (k in req.body) {
      sets.push(`${col}=?`);
      vals.push(k === "pinned" || k === "deleted" ? (req.body[k] ? 1 : 0) : req.body[k]);
    }
  }
  if ("concepts" in req.body && Array.isArray(req.body.concepts)) {
    sets.push("concepts=?");
    vals.push(JSON.stringify(req.body.concepts.map(String).slice(0, 12)));
  }
  vals.push(cid);
  req.db.prepare(`UPDATE conversations SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

// Auto-tag short, simple, one-off question conversations with a "quick question"
// concept (heuristic: ≤2 messages, a single user turn, a short prompt).
app.post("/api/profiles/:pid/auto-tag", withProfile, (req, res) => {
  const tag = String(req.body?.tag || "quick question").trim() || "quick question";
  const rows = req.db
    .prepare("SELECT id, concepts FROM conversations WHERE deleted=0")
    .all();
  const cntStmt = req.db.prepare("SELECT COUNT(*) n, SUM(role='user') u FROM messages WHERE conversation_id=?");
  const firstUser = req.db.prepare(
    "SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY ts, seq LIMIT 1",
  );
  const setConcepts = req.db.prepare("UPDATE conversations SET concepts=? WHERE id=?");
  let tagged = 0;
  for (const r of rows) {
    const { n, u } = cntStmt.get(r.id);
    if (!n || n > 2 || (u || 0) !== 1) continue; // not a single-turn Q&A
    const fu = firstUser.get(r.id)?.content || "";
    if (fu.length > 500) continue; // not "simple/short"
    let concepts;
    try { concepts = JSON.parse(r.concepts || "[]"); } catch { concepts = []; }
    if (concepts.includes(tag)) continue;
    setConcepts.run(JSON.stringify([...concepts, tag].slice(0, 12)), r.id);
    tagged++;
  }
  res.json({ ok: true, tag, tagged });
});

// Bulk soft-delete / restore a set of conversations.
app.post("/api/profiles/:pid/conversations/bulk-delete", withProfile, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
  const deleted = req.body?.deleted === false ? 0 : 1;
  if (!ids.length) return res.status(400).json({ error: "no ids" });
  const stmt = req.db.prepare("UPDATE conversations SET deleted=? WHERE id=?");
  req.db.exec("BEGIN");
  try {
    for (const id of ids) stmt.run(deleted, id);
    req.db.exec("COMMIT");
  } catch (e) {
    req.db.exec("ROLLBACK");
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, updated: ids.length, deleted: !!deleted });
});

app.delete("/api/profiles/:pid/conversations/:cid", withProfile, (req, res) => {
  req.db.prepare("DELETE FROM conversations WHERE id=?").run(req.params.cid);
  res.json({ ok: true });
});

app.post("/api/profiles/:pid/conversations/:cid/messages", withProfile, (req, res) => {
  const { cid } = req.params;
  const m = req.body;
  const id = m.id || uid("m");
  const seqRow = req.db
    .prepare("SELECT COALESCE(MAX(seq), -1)+1 s FROM messages WHERE conversation_id=?")
    .get(cid);
  req.db
    .prepare(
      "INSERT INTO messages (id, conversation_id, role, content, ts, model, context_used, seq, images) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id, cid, m.role, m.content ?? "", m.ts || Date.now(),
      m.model ?? null,
      m.contextUsed ? JSON.stringify(m.contextUsed) : null,
      seqRow.s,
      Array.isArray(m.images) && m.images.length ? JSON.stringify(m.images) : null,
    );
  // First user message becomes the conversation title.
  const conv = req.db.prepare("SELECT title FROM conversations WHERE id=?").get(cid);
  const msgCount = req.db
    .prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?")
    .get(cid).n;
  if (msgCount === 1 && m.role === "user" && conv && conv.title === "New chat") {
    req.db
      .prepare("UPDATE conversations SET title=?, updated_at=? WHERE id=?")
      .run((m.content || "New chat").slice(0, 48), Date.now(), cid);
  } else {
    req.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(Date.now(), cid);
  }
  res.status(201).json({ id });
});

app.patch(
  "/api/profiles/:pid/conversations/:cid/messages/:mid",
  withProfile,
  (req, res) => {
    req.db
      .prepare("UPDATE messages SET content=? WHERE id=? AND conversation_id=?")
      .run(req.body.content ?? "", req.params.mid, req.params.cid);
    req.db
      .prepare("UPDATE conversations SET updated_at=? WHERE id=?")
      .run(Date.now(), req.params.cid);
    res.json({ ok: true });
  },
);

// Start a NEW conversation seeded from a cluster of related conversations:
// synthesize a continuity briefing across them and open with it as context.
// Seed a new conversation from arbitrary context (e.g. an email or calendar
// event) — opens with the content as an assistant context message.
app.post("/api/profiles/:pid/conversations/seed", withProfile, (req, res) => {
  const title = String(req.body?.title || "New chat").slice(0, 80) || "New chat";
  const body = String(req.body?.body || "").slice(0, 8000);
  const now = Date.now();
  const id = uid("c");
  req.db
    .prepare("INSERT INTO conversations (id, title, created_at, updated_at, model, concepts, pinned) VALUES (?,?,?,?,?,'[]',0)")
    .run(id, title, now, now, "claude-opus-4-8");
  if (body) {
    req.db
      .prepare("INSERT INTO messages (id, conversation_id, role, content, ts, model, context_used, seq) VALUES (?,?,?,?,?,?,NULL,0)")
      .run(uid("m"), id, "assistant", body, now, "claude-opus-4-8");
  }
  const row = req.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
  const msgs = req.db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY ts, seq").all(id).map(mapMessage);
  res.status(201).json(mapConversation(row, req.pid, msgs));
});

app.post("/api/profiles/:pid/conversations/from-cluster", withProfile, async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.filter(Boolean))] : [];
    if (!ids.length) return res.status(400).json({ error: "no conversation ids" });

    const getConv = req.db.prepare("SELECT id, title, concepts FROM conversations WHERE id=?");
    const sources = [];
    for (const cid of ids) {
      const c = getConv.get(cid);
      if (!c) continue;
      sources.push({
        id: cid,
        title: c.title,
        concepts: (() => { try { return JSON.parse(c.concepts || "[]"); } catch { return []; } })(),
        transcript: transcriptOf(req.db, cid).slice(0, 4000), // cap each source
      });
    }
    if (!sources.length) return res.status(404).json({ error: "no matching conversations" });

    const model = req.body.model || "claude-opus-4-8";
    const sourceText = sources
      .map((s, i) => `### ${i + 1}. ${s.title}\n${s.transcript}`)
      .join("\n\n")
      .slice(0, 24000); // overall cap

    let recap = "";
    try {
      recap = await runModel(
        model,
        [{
          type: "text",
          text:
            "You are starting a NEW session that continues a cluster of related past conversations. " +
            "Write a concise briefing that carries their combined context forward: key facts, decisions, " +
            "and open threads — grouped by theme, not retold one-by-one. End with a short 'Where we left off' " +
            "list of open questions. Use markdown. Do not greet; write as if resuming work.",
        }],
        [{ role: "user", content: `Related conversations to merge:\n\n${sourceText}` }],
      );
    } catch {
      recap = "";
    }
    if (!recap.trim()) {
      recap =
        `Continuing from ${sources.length} related conversations:\n\n` +
        sources.map((s) => `- **${s.title}**`).join("\n");
    }
    const header =
      `📎 _Continuing from ${sources.length} related conversation${sources.length > 1 ? "s" : ""}: ` +
      `${sources.map((s) => s.title).join(" · ")}_\n\n`;

    const now = Date.now();
    const id = uid("c");
    const label = String(req.body.title || "").trim();
    const title = (
      label ||
      `Continued: ${sources.map((s) => s.title).slice(0, 2).join(" + ")}`
    ).slice(0, 60);
    const concepts = [...new Set(sources.flatMap((s) => s.concepts))].slice(0, 12);

    req.db
      .prepare(
        "INSERT INTO conversations (id, title, created_at, updated_at, model, concepts, pinned) VALUES (?,?,?,?,?,?,0)",
      )
      .run(id, title, now, now, model, JSON.stringify(concepts));
    req.db
      .prepare(
        "INSERT INTO messages (id, conversation_id, role, content, ts, model, context_used, seq) VALUES (?,?,?,?,?,?,?,0)",
      )
      .run(uid("m"), id, "assistant", header + recap, now, model, JSON.stringify({ cluster: ids }));

    const row = req.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
    const msgs = req.db
      .prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY ts, seq")
      .all(id)
      .map(mapMessage);
    res.status(201).json(mapConversation(row, req.pid, msgs));
  } catch (e) {
    res.status(e.code || 502).json({ error: e.message });
  }
});

// --- per-chat AI actions: summarize + reminder -----------------------------

// Run a model to completion (collect text only). Used for summarize/memorize/STM/LTM.
async function runModel(model, system, messages) {
  let out = "";
  if (model.startsWith("claude") && hasAnthropicKey()) {
    for await (const ev of runClaude({ model, systemBlocks: system, messages })) {
      if (ev.type === "text") out += ev.v;
    }
  } else if (model.startsWith("gemini") && hasGeminiKey()) {
    for await (const d of streamGemini({ model, system, messages })) out += d;
  } else {
    throw new Error(`no API key configured for ${model}`);
  }
  return out;
}

function transcriptOf(db, cid) {
  const msgs = db
    .prepare("SELECT role, content FROM messages WHERE conversation_id=? ORDER BY ts, seq")
    .all(cid);
  return msgs
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n\n");
}

function firstJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : JSON.parse(text);
}

// Summarize a conversation: returns {subject, summary, topics} and merges the
// extracted topic labels onto the conversation's concepts (feeds the graph).
async function summarizeConversation(db, cid) {
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(cid);
  if (!conv) throw Object.assign(new Error("no such conversation"), { code: 404 });
  const transcript = transcriptOf(db, cid);
  if (!transcript.trim())
    throw Object.assign(new Error("conversation is empty"), { code: 400 });

  const raw = await runModel(
    conv.model,
    "Analyze the conversation and respond ONLY with JSON (no prose, no code fences): " +
      '{"subject": "<a 3-6 word subject/title>", "summary": "<3-5 sentences capturing decisions, key facts, and open questions>", "topics": ["<2-5 short topic labels, 1-3 words each>"]}',
    [{ role: "user", content: `Conversation:\n\n${transcript}\n\nReturn the JSON.` }],
  );
  let parsed;
  try {
    parsed = firstJson(raw);
  } catch {
    parsed = { subject: conv.title, summary: raw.trim(), topics: [] };
  }
  const subject = String(parsed.subject || conv.title).slice(0, 80);
  const summary = String(parsed.summary || "").trim() || raw.trim();
  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.map((t) => String(t).trim()).filter(Boolean)
    : [];

  const existing = JSON.parse(conv.concepts || "[]");
  const merged = [...new Set([...existing, ...topics])].slice(0, 8);
  // Persist the summary as conversation metadata so it surfaces everywhere the
  // conversation appears (sidebar, graph previews, cluster panels).
  db.prepare("UPDATE conversations SET concepts=?, summary=?, subject=? WHERE id=?").run(
    JSON.stringify(merged),
    summary,
    subject,
    cid,
  );
  return { subject, summary, topics: merged };
}

app.post("/api/profiles/:pid/conversations/:cid/summarize", withProfile, async (req, res) => {
  try {
    const result = await summarizeConversation(req.db, req.params.cid);
    // Stage the metadata JSON for later sync to durable storage.
    writeConvMeta(req.pid, req.params.cid, result);
    res.json(result);
  } catch (e) {
    res.status(e.code || 502).json({ error: e.message });
  }
});

// Memorize: summarize, then persist the summary into the profile's memory log.
app.post("/api/profiles/:pid/conversations/:cid/memorize", withProfile, async (req, res) => {
  try {
    const { subject, summary, topics } = await summarizeConversation(req.db, req.params.cid);
    writeConvMeta(req.pid, req.params.cid, { subject, summary, topics });
    const id = uid("mem");
    req.db
      .prepare(
        "INSERT INTO memory (id, conversation_id, subject, body, created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, req.params.cid, subject, summary, Date.now());
    res.status(201).json({ id, subject, summary, topics });
  } catch (e) {
    res.status(e.code || 502).json({ error: e.message });
  }
});

app.get("/api/profiles/:pid/memory", withProfile, (req, res) => {
  const rows = req.db.prepare("SELECT * FROM memory ORDER BY created_at DESC").all();
  res.json(
    rows.map((r) => ({
      id: r.id,
      profileId: req.pid,
      conversationId: r.conversation_id ?? undefined,
      subject: r.subject,
      body: r.body,
      createdAt: r.created_at,
    })),
  );
});

app.delete("/api/profiles/:pid/memory/:mid", withProfile, (req, res) => {
  req.db.prepare("DELETE FROM memory WHERE id=?").run(req.params.mid);
  res.json({ ok: true });
});

app.post("/api/profiles/:pid/conversations/:cid/reminder", withProfile, async (req, res) => {
  const conv = req.db.prepare("SELECT * FROM conversations WHERE id=?").get(req.params.cid);
  if (!conv) return res.status(404).json({ error: "no such conversation" });
  const transcript = transcriptOf(req.db, req.params.cid);
  if (!transcript.trim()) return res.status(400).json({ error: "conversation is empty" });

  try {
    const raw = await runModel(
      conv.model,
      'Extract the single most useful follow-up action from the conversation. Respond ONLY with JSON (no prose): ' +
        '{"text": "<short imperative reminder>", "dueInDays": <integer 1-30>}',
      [{ role: "user", content: `Conversation:\n\n${transcript}\n\nReturn the reminder JSON.` }],
    );
    let parsed;
    try {
      parsed = firstJson(raw);
    } catch {
      parsed = { text: raw.trim().slice(0, 120), dueInDays: 1 };
    }
    res.json({
      text: String(parsed.text || "Follow up on this chat").slice(0, 160),
      dueInDays: Math.min(30, Math.max(1, Number(parsed.dueInDays) || 1)),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- layered memory: short-term (STM) + long-term (LTM) --------------------

function gatherActivity(db) {
  const convs = db
    .prepare("SELECT title, concepts, updated_at FROM conversations WHERE deleted=0 ORDER BY updated_at DESC LIMIT 12")
    .all()
    .map(
      (c) =>
        `- ${c.title} [${JSON.parse(c.concepts || "[]").join(", ")}] (${new Date(c.updated_at).toISOString().slice(0, 10)})`,
    );
  const reminders = db
    .prepare("SELECT text, due_at FROM reminders WHERE done=0 ORDER BY due_at LIMIT 20")
    .all()
    .map((r) => `- ${r.text} (due ${new Date(r.due_at).toISOString().slice(0, 10)})`);
  const mems = db
    .prepare("SELECT subject, body FROM memory ORDER BY created_at DESC LIMIT 20")
    .all()
    .map((m) => `- ${m.subject}: ${m.body}`);
  return { convs, reminders, mems };
}

// --- personal details → woven into the LTM file -----------------------------

const PD_START = "<!-- PERSONAL_DETAILS -->";
const PD_END = "<!-- /PERSONAL_DETAILS -->";

function detailsToMarkdown(d) {
  const L = [];
  if (d.name) L.push(`- **Name:** ${d.name}`);
  if (d.location) L.push(`- **Location:** ${d.location}`);
  if (d.role) L.push(`- **Role / occupation:** ${d.role}`);
  if (d.bio) L.push(`- **About:** ${d.bio}`);
  const sites = (d.websites || []).filter(Boolean);
  if (sites.length) L.push(`- **Websites:** ${sites.join(", ")}`);
  for (const s of d.socials || [])
    if (s && (s.url || s.handle))
      L.push(`- **${s.label || "Social"}:** ${[s.handle, s.url].filter(Boolean).join(" — ")}`);
  for (const c of d.custom || [])
    if (c && c.label && c.value) L.push(`- **${c.label}:** ${c.value}`);
  return L.join("\n");
}
function stripDetailsBlock(ltm) {
  const s = ltm.indexOf(PD_START);
  const e = ltm.indexOf(PD_END);
  if (s < 0 || e < 0) return ltm.trim();
  return (ltm.slice(0, s) + ltm.slice(e + PD_END.length)).trim();
}
function extractDetailsBlock(ltm) {
  const s = ltm.indexOf(PD_START);
  const e = ltm.indexOf(PD_END);
  if (s < 0 || e < 0) return "";
  return ltm.slice(s, e + PD_END.length);
}
function detailsBlock(d) {
  const md = detailsToMarkdown(d);
  return md ? `${PD_START}\n## Personal details\n${md}\n${PD_END}` : "";
}

app.get("/api/profiles/:pid/details", withProfile, (req, res) => {
  res.json(readDetails(req.pid) || {});
});

app.put("/api/profiles/:pid/details", withProfile, (req, res) => {
  const d = req.body || {};
  writeDetails(req.pid, d);
  // weave the (managed) personal-details block into the top of the LTM file
  const rest = stripDetailsBlock(readMemFile(req.pid, LTM_FILE).content);
  const block = detailsBlock(d);
  const next = [block, rest].filter(Boolean).join("\n\n").trim();
  writeMemFile(req.pid, LTM_FILE, next);
  syncBio(req.pid); // mirror to personal-claude/bio/
  res.json({ details: d, ltm: next });
});

app.get("/api/profiles/:pid/memory-files", withProfile, (req, res) => {
  const stm = readMemFile(req.pid, STM_FILE);
  const ltm = readMemFile(req.pid, LTM_FILE);
  res.json({
    stm: stm.content,
    stmUpdated: stm.updatedAt,
    ltm: ltm.content,
    ltmUpdated: ltm.updatedAt,
  });
});

// Short-term memory: regenerate from the latest activity (time-relevant).
async function rebuildStm(pid) {
  const prow = systemDb.prepare("SELECT default_model FROM profiles WHERE id=?").get(pid);
  const model = prow?.default_model || "claude-opus-4-8";
  const a = gatherActivity(getProfileDb(pid));
  const content = await runModel(
    model,
    "You maintain a SHORT-TERM MEMORY for a user's AI assistant. From the recent activity, write the user's current, time-relevant state: what they're actively working on, recent topics, and pending tasks/reminders. Concise markdown bullets (max ~12). Focus on the last several days; OMIT durable long-term interests. Output only the memory content, no preamble.",
    [
      {
        role: "user",
        content:
          `Recent conversations:\n${a.convs.join("\n") || "(none)"}\n\n` +
          `Open tasks / reminders:\n${a.reminders.join("\n") || "(none)"}\n\n` +
          `Recent saved notes:\n${a.mems.join("\n") || "(none)"}\n\n` +
          "Write the updated short-term memory.",
      },
    ],
  );
  writeMemFile(pid, STM_FILE, content.trim());
  return content.trim();
}

app.post("/api/profiles/:pid/stm", withProfile, async (req, res) => {
  try {
    const content = await rebuildStm(req.pid);
    res.json({ content, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Long-term memory: incrementally consolidate durable interests/ideas/projects.
app.post("/api/profiles/:pid/ltm", withProfile, async (req, res) => {
  const prow = systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(req.pid);
  const model = prow?.default_model || "claude-opus-4-8";
  const prevFull = readMemFile(req.pid, LTM_FILE).content;
  const pdBlock = extractDetailsBlock(prevFull); // curated personal details (preserved verbatim)
  const prev = stripDetailsBlock(prevFull);
  const stm = readMemFile(req.pid, STM_FILE).content;
  const a = gatherActivity(req.db);
  try {
    const content = await runModel(
      model,
      "You maintain a LONG-TERM MEMORY for a user's AI assistant. Update it INCREMENTALLY: preserve durable facts already present, and fold in enduring interests, recurring themes, big ideas, ongoing projects, and stable preferences. EXCLUDE transient tasks, one-off reminders, and short-lived details. Keep it organized markdown with sections (e.g. Interests, Projects, Preferences, Themes). Output only the memory content, no preamble.",
      [
        {
          role: "user",
          content:
            `Existing long-term memory:\n${prev || "(empty)"}\n\n` +
            `Current short-term memory:\n${stm || "(empty)"}\n\n` +
            `Saved notes:\n${a.mems.join("\n") || "(none)"}\n\n` +
            "Produce the updated long-term memory.",
        },
      ],
    );
    // re-prepend the curated personal-details block so it survives consolidation
    const merged = [pdBlock, content.trim()].filter(Boolean).join("\n\n").trim();
    writeMemFile(req.pid, LTM_FILE, merged);
    syncBio(req.pid); // mirror to personal-claude/bio/
    res.json({ content: merged, updatedAt: Date.now() });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// --- notes -----------------------------------------------------------------

app.get("/api/profiles/:pid/notes", withProfile, (req, res) => {
  const rows = req.db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all();
  res.json(rows.map((r) => mapNote(r, req.pid)));
});

app.post("/api/profiles/:pid/notes", withProfile, (req, res) => {
  const now = Date.now();
  const id = uid("n");
  const b = req.body;
  req.db
    .prepare(
      "INSERT INTO notes (id, conversation_id, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run(id, b.conversationId ?? null, b.title ?? "", b.body ?? "", now, now);
  res.status(201).json(mapNote(req.db.prepare("SELECT * FROM notes WHERE id=?").get(id), req.pid));
});

app.patch("/api/profiles/:pid/notes/:nid", withProfile, (req, res) => {
  const fields = { title: "title", body: "body" };
  const sets = ["updated_at=?"];
  const vals = [Date.now()];
  for (const [k, col] of Object.entries(fields)) {
    if (k in req.body) {
      sets.push(`${col}=?`);
      vals.push(req.body[k]);
    }
  }
  vals.push(req.params.nid);
  req.db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  res.json({ ok: true });
});

app.delete("/api/profiles/:pid/notes/:nid", withProfile, (req, res) => {
  req.db.prepare("DELETE FROM notes WHERE id=?").run(req.params.nid);
  res.json({ ok: true });
});

// --- reminders -------------------------------------------------------------

app.get("/api/profiles/:pid/reminders", withProfile, (req, res) => {
  const rows = req.db.prepare("SELECT * FROM reminders ORDER BY done, due_at").all();
  res.json(rows.map((r) => mapReminder(r, req.pid)));
});

app.post("/api/profiles/:pid/reminders", withProfile, (req, res) => {
  const id = uid("r");
  const b = req.body;
  req.db
    .prepare("INSERT INTO reminders (id, text, due_at, done, conversation_id, repeat) VALUES (?,?,?,?,?,?)")
    .run(id, b.text, b.dueAt || Date.now(), b.done ? 1 : 0, b.conversationId ?? null, b.repeat || "none");
  res.status(201).json(mapReminder(req.db.prepare("SELECT * FROM reminders WHERE id=?").get(id), req.pid));
});

app.patch("/api/profiles/:pid/reminders/:rid", withProfile, (req, res) => {
  const sets = [];
  const vals = [];
  if ("done" in req.body) {
    sets.push("done=?");
    vals.push(req.body.done ? 1 : 0);
  }
  if ("dueAt" in req.body) {
    sets.push("due_at=?");
    vals.push(Number(req.body.dueAt) || Date.now());
  }
  if ("text" in req.body) {
    sets.push("text=?");
    vals.push(String(req.body.text));
  }
  if ("repeat" in req.body) {
    sets.push("repeat=?");
    vals.push(String(req.body.repeat || "none"));
  }
  if (sets.length) {
    vals.push(req.params.rid);
    req.db.prepare(`UPDATE reminders SET ${sets.join(", ")} WHERE id=?`).run(...vals);
  }
  res.json({ ok: true });
});

app.delete("/api/profiles/:pid/reminders/:rid", withProfile, (req, res) => {
  req.db.prepare("DELETE FROM reminders WHERE id=?").run(req.params.rid);
  res.json({ ok: true });
});

// Lookup a word/phrase across the profile's own context AND the web (via Claude
// web search). Powers the right-click "search context & web" action.
app.post("/api/profiles/:pid/lookup", withProfile, async (req, res) => {
  const q = String(req.body?.q || "").trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: "empty query" });
  const like = `%${q.toLowerCase()}%`;

  const convs = req.db
    .prepare(
      "SELECT id, title, summary FROM conversations WHERE deleted=0 AND (lower(title) LIKE ? OR lower(summary) LIKE ? OR lower(concepts) LIKE ?) ORDER BY updated_at DESC LIMIT 8",
    )
    .all(like, like, like)
    .map((c) => ({ type: "conversation", id: c.id, conversationId: c.id, title: c.title, snippet: (c.summary || "").slice(0, 160) }));
  const notes = req.db
    .prepare("SELECT id, title, body, conversation_id FROM notes WHERE lower(title) LIKE ? OR lower(body) LIKE ? ORDER BY updated_at DESC LIMIT 6")
    .all(like, like)
    .map((n) => ({ type: "note", id: n.id, conversationId: n.conversation_id, title: n.title || "Note", snippet: (n.body || "").slice(0, 160) }));
  const mems = req.db
    .prepare("SELECT id, subject, body, conversation_id FROM memory WHERE lower(subject) LIKE ? OR lower(body) LIKE ? ORDER BY created_at DESC LIMIT 6")
    .all(like, like)
    .map((m) => ({ type: "memory", id: m.id, conversationId: m.conversation_id, title: m.subject, snippet: (m.body || "").slice(0, 160) }));
  const local = [...convs, ...notes, ...mems];

  let web = { summary: "", sources: [] };
  if (hasAnthropicKey()) {
    try {
      let text = "";
      const sources = [];
      for await (const ev of runClaude({
        model: "claude-opus-4-8",
        systemBlocks: [{
          type: "text",
          text: "You are a research assistant. Use web search to find authoritative references for the user's term, then give a concise 2–3 sentence explanation grounded in citations.",
        }],
        messages: [{ role: "user", content: `Find relevant, authoritative references and a brief explanation for: "${q}"` }],
        webTools: true,
        thinking: false,
        effort: "low",
      })) {
        if (ev.type === "text") text += ev.v;
        else if (ev.type === "sources") for (const s of ev.items || []) sources.push(s);
      }
      const seen = new Set();
      const uniq = [];
      for (const s of sources) if (s.url && !seen.has(s.url)) { seen.add(s.url); uniq.push(s); }
      web = { summary: text.trim(), sources: uniq.slice(0, 8) };
    } catch (e) {
      web = { summary: "", sources: [], error: e.message };
    }
  }
  res.json({ q, local, web });
});

// --- Google Workspace (Gmail + Calendar) per-profile sync ------------------

function getIntegration(pid) {
  const db = getProfileDb(pid);
  const row = db.prepare("SELECT data, connected_at, last_sync FROM integrations WHERE provider='google'").get();
  if (!row) return null;
  let d = {};
  try { d = JSON.parse(row.data || "{}"); } catch { /* */ }
  return { ...d, connectedAt: row.connected_at, lastSync: row.last_sync };
}
function setIntegration(pid, d) {
  const db = getProfileDb(pid);
  const store = JSON.stringify({ refreshToken: d.refreshToken, email: d.email, scope: d.scope, syncState: d.syncState || {} });
  const exists = db.prepare("SELECT 1 FROM integrations WHERE provider='google'").get();
  if (exists) db.prepare("UPDATE integrations SET data=?, last_sync=? WHERE provider='google'").run(store, d.lastSync ?? null);
  else db.prepare("INSERT INTO integrations (provider, data, connected_at, last_sync) VALUES ('google',?,?,?)").run(store, Date.now(), d.lastSync ?? null);
}
function clearIntegration(pid) {
  getProfileDb(pid).prepare("DELETE FROM integrations WHERE provider='google'").run();
}

const gTokenCache = new Map(); // pid -> { token, exp }
async function getGoogleAccess(pid) {
  const it = getIntegration(pid);
  if (!it?.refreshToken) throw Object.assign(new Error("not connected"), { code: 400 });
  const c = gTokenCache.get(pid);
  if (c && c.exp > Date.now() + 30_000) return c.token;
  const { accessToken, expiresIn } = await gws.refreshAccess(gws.decrypt(it.refreshToken));
  gTokenCache.set(pid, { token: accessToken, exp: Date.now() + expiresIn * 1000 });
  return accessToken;
}

// Turn calendar events + emails into reminders + an inbox digest. Shared by the
// live API sync and the offline Takeout import.
async function applyGoogleData(pid, events, msgs) {
  const db = getProfileDb(pid);
  const have = new Set(
    db.prepare("SELECT source_ref FROM reminders WHERE source_ref IS NOT NULL").all().map((r) => r.source_ref),
  );
  const insRem = db.prepare(
    "INSERT INTO reminders (id, text, due_at, done, conversation_id, repeat, source, source_ref) VALUES (?,?,?,0,NULL,'none',?,?)",
  );
  let calendar = 0;
  let gmail = 0;
  let digest = "";

  for (const e of events || []) {
    if (have.has(e.instanceRef)) continue;
    insRem.run(uid("r"), `📅 ${e.title}${e.location ? ` @ ${e.location}` : ""}`, e.start, "gcal", e.instanceRef);
    have.add(e.instanceRef);
    calendar++;
  }

  if ((msgs || []).length) {
    // persist the raw email list (deduped) so it can be browsed
    const insMail = db.prepare(
      "INSERT OR REPLACE INTO emails (id, ts, from_addr, subject, snippet, source) VALUES (?,?,?,?,?,'gmail')",
    );
    for (const m of msgs) insMail.run(m.id, m.ts || Date.now(), m.from || "", m.subject || "", m.snippet || "");
    try {
      const prow = systemDb.prepare("SELECT default_model FROM profiles WHERE id=?").get(pid);
      const model = prow?.default_model || "claude-opus-4-8";
      const raw = await runModel(
        model,
        'You triage a person\'s recent emails. Return ONLY JSON: {"tasks":[{"i":<index>,"text":"action to take","dueInDays":<1-14 optional>}],"digest":"2-4 sentence summary of what needs attention"}. Only include tasks that need the user to DO something (reply, pay, schedule, decide); skip newsletters and notifications.',
        [{ role: "user", content: "Emails:\n" + msgs.map((m, i) => `${i}. From: ${m.from}\n   Subject: ${m.subject}\n   ${m.snippet}`).join("\n\n") + "\n\nReturn the JSON." }],
      );
      let parsed = { tasks: [], digest: "" };
      try { parsed = firstJson(raw); } catch { /* */ }
      digest = String(parsed.digest || "").trim();
      for (const t of parsed.tasks || []) {
        const msg = msgs[t.i];
        if (!msg) continue;
        const ref = `gmail:${msg.id}`;
        if (have.has(ref)) continue;
        const days = Math.min(14, Math.max(1, Number(t.dueInDays) || 2));
        insRem.run(uid("r"), `✉️ ${String(t.text).slice(0, 160)}`, Date.now() + days * 86_400_000, "gmail", ref);
        have.add(ref);
        gmail++;
      }
      if (digest) {
        const title = `📥 Inbox digest ${new Date().toISOString().slice(0, 10)}`;
        db.prepare("DELETE FROM notes WHERE title=?").run(title);
        db.prepare("INSERT INTO notes (id, conversation_id, title, body, created_at, updated_at) VALUES (?,NULL,?,?,?,?)")
          .run(uid("n"), title, digest, Date.now(), Date.now());
      }
    } catch { /* LLM/digest best-effort */ }
  }

  return { calendar, gmail, digest };
}

// Pull calendar events + email action-items from the live Google API.
async function syncProfileGoogle(pid) {
  const it = getIntegration(pid);
  if (!it?.refreshToken) throw Object.assign(new Error("not connected"), { code: 400 });
  const access = await getGoogleAccess(pid);
  const now = Date.now();
  let events = [];
  let msgs = [];
  try { events = await gws.listCalendarEvents(access, now, now + 14 * 86_400_000); } catch { /* */ }
  try { msgs = await gws.listGmail(access); } catch { /* */ }
  const r = await applyGoogleData(pid, events, msgs);
  setIntegration(pid, { ...it, lastSync: Date.now() });
  return { ok: true, ...r };
}

// Read an mbox in full when it's modestly sized (Takeout date-range exports
// usually are); otherwise read the last maxBytes. Mbox ordering isn't reliable,
// so reading whole + sorting by Date is the robust path.
function readMbox(path, whole = 64 * 1024 * 1024, tail = 24 * 1024 * 1024) {
  const size = statSync(path).size;
  if (size <= whole) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(tail);
    readSync(fd, buf, 0, tail, size - tail);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Offline test: import a Google Takeout folder (*.ics calendar + *.mbox mail) and
// run the same pipeline — no API connection required.
app.post("/api/profiles/:pid/google/import-export", withProfile, async (req, res) => {
  try {
    const dir = resolveExportDir(req.body?.dir);
    const days = Math.min(120, Math.max(1, Number(req.body?.days) || 31)); // recent window (default 1 month)
    let events = [];
    let msgs = [];
    const walk = (d) => {
      for (const name of readdirSync(d)) {
        if (name.startsWith("._")) continue;
        const p = join(d, name);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (/\.ics$/i.test(name)) events.push(...gws.parseIcs(readFileSync(p, "utf8")));
        else if (/\.mbox$/i.test(name)) msgs.push(...gws.parseMbox(readMbox(p)));
      }
    };
    walk(dir);
    const parsedEvents = events.length;
    const parsedEmails = msgs.length;
    // calendar: recent + upcoming
    events = events.filter((e) => e.start >= Date.now() - 7 * 86_400_000 && e.start <= Date.now() + 30 * 86_400_000).slice(0, 100);
    // email: newest first; prefer the last `days`, but if the export predates that
    // window (Takeout date-range exports), fall back to the newest available.
    const since = Date.now() - days * 86_400_000;
    const dated = msgs.filter((m) => m.ts > 0).sort((a, b) => b.ts - a.ts);
    const undated = msgs.filter((m) => m.ts === 0);
    let recent = dated.filter((m) => m.ts >= since);
    if (recent.length < 3) recent = dated.slice(0, 30); // export older than the window
    msgs = [...recent, ...undated].slice(0, 30);
    const r = await applyGoogleData(req.pid, events, msgs);
    res.json({ ok: true, ...r, parsedEvents, parsedEmails, windowDays: days, windowedEvents: events.length, windowedEmails: msgs.length });
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

app.post("/api/profiles/:pid/google/auth-url", withProfile, (req, res) => {
  if (!gws.workspaceConfigured())
    return res.status(400).json({ error: "Google client/secret not configured on the server" });
  res.json({ url: gws.authUrl(gws.signState(req.pid, req.user?.sub || "anon")) });
});

// OAuth redirect target (public — validated by the signed state)
app.get("/api/google/callback", async (req, res) => {
  const page = (msg) =>
    `<!doctype html><meta charset=utf-8><body style="font:15px -apple-system,sans-serif;padding:48px;text-align:center;background:#0d0f14;color:#ece6d8"><p>${msg}</p><script>setTimeout(()=>window.close(),1800)</script></body>`;
  if (req.query.error) return res.send(page("Connection cancelled — you can close this window."));
  const st = req.query.state ? gws.verifyState(String(req.query.state)) : null;
  if (!st || !req.query.code) return res.status(400).send(page("Invalid or expired request."));
  try {
    const tok = await gws.exchangeCode(String(req.query.code));
    if (!tok.refresh_token)
      return res.send(page("No refresh token — revoke this app at myaccount.google.com/permissions, then reconnect."));
    let email = "";
    try { email = (await gws.userInfo(tok.access_token)).email || ""; } catch { /* */ }
    setIntegration(st.pid, { refreshToken: gws.encrypt(tok.refresh_token), email, scope: tok.scope, syncState: {} });
    res.send(page(`Connected ${email || "Google"} ✓ — you can close this window.`));
  } catch (e) {
    res.status(500).send(page("Connection failed: " + e.message));
  }
});

app.get("/api/profiles/:pid/emails", withProfile, (req, res) => {
  const rows = req.db
    .prepare("SELECT id, ts, from_addr, subject, snippet, source FROM emails ORDER BY ts DESC LIMIT 300")
    .all();
  res.json({ emails: rows.map((r) => ({ id: r.id, ts: r.ts, from: r.from_addr, subject: r.subject, snippet: r.snippet, source: r.source })) });
});

app.get("/api/profiles/:pid/integrations", withProfile, (req, res) => {
  const it = getIntegration(req.pid);
  res.json({
    configured: gws.workspaceConfigured(),
    google: it
      ? { connected: true, email: it.email || null, lastSync: it.lastSync || null, scope: it.scope || "" }
      : { connected: false },
  });
});

app.post("/api/profiles/:pid/google/sync", withProfile, async (req, res) => {
  try {
    res.json(await syncProfileGoogle(req.pid));
  } catch (e) {
    res.status(e.code || 502).json({ error: e.message });
  }
});

app.delete("/api/profiles/:pid/google", withProfile, async (req, res) => {
  const it = getIntegration(req.pid);
  if (it?.refreshToken) await gws.revoke(gws.decrypt(it.refreshToken));
  clearIntegration(req.pid);
  gTokenCache.delete(req.pid);
  res.json({ ok: true });
});

// --- scheduled daily tasks (per profile) -----------------------------------

// A daily-briefing note: today + what needs attention, from reminders + STM + activity.
async function jobDailyBriefing(pid) {
  const db = getProfileDb(pid);
  const a = gatherActivity(db);
  const soon = db
    .prepare("SELECT text, due_at FROM reminders WHERE done=0 AND due_at <= ? ORDER BY due_at LIMIT 30")
    .all(Date.now() + 3 * 86_400_000)
    .map((r) => `- ${r.text} (${new Date(r.due_at).toISOString().slice(0, 10)})`);
  const stm = readMemFile(pid, STM_FILE).content;
  const model = systemDb.prepare("SELECT default_model FROM profiles WHERE id=?").get(pid)?.default_model || "claude-opus-4-8";
  const briefing = await runModel(
    model,
    "You write a concise daily briefing for the user. Produce: a one-line 'today' summary, a short prioritized list of what needs attention (tasks/reminders due soon), and any notable recent threads. Markdown, friendly, under 200 words, no preamble.",
    [{
      role: "user",
      content:
        `Date: ${new Date().toDateString()}\n\n` +
        `Due soon / overdue:\n${soon.join("\n") || "(none)"}\n\n` +
        `Short-term memory:\n${stm || "(none)"}\n\n` +
        `Recent conversations:\n${a.convs.join("\n") || "(none)"}\n\nWrite the briefing.`,
    }],
  );
  const title = `🗞️ Daily briefing ${new Date().toISOString().slice(0, 10)}`;
  db.prepare("DELETE FROM notes WHERE title=?").run(title);
  db.prepare("INSERT INTO notes (id, conversation_id, title, body, created_at, updated_at) VALUES (?,NULL,?,?,?,?)")
    .run(uid("n"), title, briefing.trim(), Date.now(), Date.now());
  return `briefing saved · ${soon.length} due soon`;
}

const JOBS = {
  "google-sync": {
    label: "Sync Gmail & Calendar",
    run: async (pid) => {
      const it = getIntegration(pid);
      if (!it?.refreshToken) return "skipped — not connected";
      const r = await syncProfileGoogle(pid);
      return `${r.calendar} calendar · ${r.gmail} email${r.digest ? " · digest" : ""}`;
    },
  },
  "refresh-stm": { label: "Refresh short-term memory", run: async (pid) => { await rebuildStm(pid); return "STM refreshed"; } },
  "daily-briefing": { label: "Daily briefing", run: jobDailyBriefing },
};
const JOB_ORDER = ["google-sync", "refresh-stm", "daily-briefing"];

function getTasks(pid) {
  const db = getProfileDb(pid);
  const rows = Object.fromEntries(
    db.prepare("SELECT name, enabled, last_run, last_result FROM scheduled_tasks").all().map((r) => [r.name, r]),
  );
  return JOB_ORDER.map((name) => {
    const r = rows[name];
    return { name, label: JOBS[name].label, enabled: r ? !!r.enabled : true, lastRun: r?.last_run || null, lastResult: r?.last_result || null };
  });
}
function setTaskEnabled(pid, name, enabled) {
  const db = getProfileDb(pid);
  const ex = db.prepare("SELECT 1 FROM scheduled_tasks WHERE name=?").get(name);
  if (ex) db.prepare("UPDATE scheduled_tasks SET enabled=? WHERE name=?").run(enabled ? 1 : 0, name);
  else db.prepare("INSERT INTO scheduled_tasks (name, enabled) VALUES (?,?)").run(name, enabled ? 1 : 0);
}
function recordTaskRun(pid, name, result) {
  const db = getProfileDb(pid);
  const r = String(result).slice(0, 300);
  const ex = db.prepare("SELECT 1 FROM scheduled_tasks WHERE name=?").get(name);
  if (ex) db.prepare("UPDATE scheduled_tasks SET last_run=?, last_result=? WHERE name=?").run(Date.now(), r, name);
  else db.prepare("INSERT INTO scheduled_tasks (name, enabled, last_run, last_result) VALUES (?,1,?,?)").run(name, Date.now(), r);
}
async function runTask(pid, name) {
  if (!JOBS[name]) throw Object.assign(new Error("unknown task"), { code: 400 });
  let result;
  try {
    result = await JOBS[name].run(pid);
  } catch (e) {
    recordTaskRun(pid, name, "error: " + e.message);
    throw Object.assign(new Error(e.message), { code: 502 });
  }
  recordTaskRun(pid, name, result);
  return result;
}

app.get("/api/profiles/:pid/tasks", withProfile, (req, res) => {
  res.json({ tasks: getTasks(req.pid) });
});
app.patch("/api/profiles/:pid/tasks/:name", withProfile, (req, res) => {
  if (!JOBS[req.params.name]) return res.status(400).json({ error: "unknown task" });
  setTaskEnabled(req.pid, req.params.name, req.body?.enabled !== false);
  res.json({ ok: true });
});
app.post("/api/profiles/:pid/tasks/:name/run", withProfile, async (req, res) => {
  try {
    const result = await runTask(req.pid, req.params.name);
    res.json({ ok: true, name: req.params.name, result, lastRun: Date.now() });
  } catch (e) {
    res.status(e.code || 502).json({ error: e.message });
  }
});
app.post("/api/profiles/:pid/tasks/run-all", withProfile, async (req, res) => {
  const ran = [];
  for (const t of getTasks(req.pid)) {
    if (!t.enabled) continue;
    try { ran.push({ name: t.name, result: await runTask(req.pid, t.name) }); }
    catch (e) { ran.push({ name: t.name, result: "error: " + e.message }); }
  }
  res.json({ ok: true, ran });
});

// Daily scheduler: run each profile's enabled tasks if not run in ~20h.
function startDailyScheduler() {
  const run = async () => {
    try {
      for (const { id } of systemDb.prepare("SELECT id FROM profiles").all()) {
        for (const t of getTasks(id)) {
          if (!t.enabled) continue;
          if (t.lastRun && Date.now() - t.lastRun < 20 * 3_600_000) continue;
          try { await runTask(id, t.name); } catch { /* */ }
        }
      }
    } catch { /* */ }
  };
  setTimeout(run, 30_000);
  setInterval(run, 3_600_000);
}

// --- chat gateway ----------------------------------------------------------

app.post("/api/chat", async (req, res) => {
  const {
    profileId,
    model = "gemini-2.5-pro",
    messages = [],
    conversationId,
    messageId,
    context = [],
  } = req.body;
  const profile = profileId
    ? systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(profileId)
    : null;

  if (profile && !emailCanAccess(profile, req.user?.email)) {
    return res.status(403).json({ error: "forbidden" });
  }

  // Build a context block from the conversations the user attached as relevant,
  // so the chat is aligned to those past points (title + summary/excerpt).
  let retrieved = "";
  if (profileId && Array.isArray(context) && context.length && profileExists(profileId)) {
    try {
      const cdb = getProfileDb(profileId);
      const getC = cdb.prepare("SELECT id, title, summary, concepts FROM conversations WHERE id=?");
      const getN = cdb.prepare("SELECT title, body FROM notes WHERE id=?");
      const getM = cdb.prepare("SELECT subject, body FROM memory WHERE id=?");
      const parts = [];
      for (const item of context.slice(0, 8)) {
        const type = typeof item === "string" ? "conversation" : item?.type;
        const id = typeof item === "string" ? item : item?.id;
        if (!id) continue;
        if (type === "note") {
          const n = getN.get(id);
          if (n) parts.push(`### Note: ${n.title || "Note"}\n${n.body}`);
        } else if (type === "memory") {
          const m = getM.get(id);
          if (m) parts.push(`### Memory: ${m.subject}\n${m.body}`);
        } else {
          const c = getC.get(id);
          if (!c) continue;
          let topics = "";
          try { topics = JSON.parse(c.concepts || "[]").join(", "); } catch { /* */ }
          let body = (c.summary || "").trim();
          if (!body) body = transcriptOf(cdb, id).slice(0, 600);
          parts.push(`### ${c.title}${topics ? ` [${topics}]` : ""}\n${body || "(no summary)"}`);
        }
      }
      if (parts.length)
        retrieved =
          "<retrieved_context>\nThe user attached these related past conversations to align this chat. Use them when relevant:\n\n" +
          parts.join("\n\n") +
          "\n</retrieved_context>";
    } catch {
      /* best-effort */
    }
  }

  // Newline-delimited JSON event stream: {type:"text"|"thinking"|"tool"|"sources"|"done", ...}
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  const isClaude = model.startsWith("claude");
  const isGemini = model.startsWith("gemini");
  const settings = parseSettings(profile?.settings);
  let usage = null;
  const onUsage = (u) => {
    usage = u;
  };

  try {
    if (isClaude && hasAnthropicKey()) {
      const systemBlocks = buildSystem({
        persona: profile?.persona,
        userContext: profileId ? readContext(profileId) : "",
        ltm: profileId ? readMemFile(profileId, LTM_FILE).content : "",
        stm: profileId ? readMemFile(profileId, STM_FILE).content : "",
      });
      if (retrieved) systemBlocks.push({ type: "text", text: retrieved });
      for await (const ev of runClaude({
        model,
        systemBlocks,
        messages,
        thinking: !!settings.thinking,
        effort: settings.effort || "high",
        webTools: !!settings.webTools,
        memory: !!settings.memory,
        memoryDir: settings.memory && profileId ? memoryDir(profileId) : null,
        onUsage,
      })) {
        send(ev);
      }
    } else if (isClaude) {
      send({ type: "text", v: "⚠️ No ANTHROPIC_API_KEY configured on the server." });
    } else if (isGemini && hasGeminiKey()) {
      const system = [profile?.persona || "", retrieved].filter(Boolean).join("\n\n");
      for await (const delta of streamGemini({ model, system, messages, onUsage })) {
        send({ type: "text", v: delta });
      }
    } else if (isGemini) {
      send({ type: "text", v: "⚠️ No GEMINI_API_KEY configured on the server." });
    } else {
      send({ type: "text", v: `*(Unknown model ${model}.)*` });
    }
  } catch (e) {
    send({ type: "text", v: `\n\n⚠️ Gateway error: ${e.message}` });
  }

  if (usage && profileId && conversationId && messageId && profileExists(profileId)) {
    try {
      getProfileDb(profileId)
        .prepare(
          "UPDATE messages SET input_tokens=?, output_tokens=? WHERE id=? AND conversation_id=?",
        )
        .run(usage.input | 0, usage.output | 0, messageId, conversationId);
    } catch {
      /* best-effort */
    }
  }
  send({ type: "done" });
  res.end();
});

// --- generate showcase / mock conversations --------------------------------

const MOCK_SET = [
  { t: "Pricing tiers for launch", c: ["pricing", "positioning", "roadmap"], d: 39, m: 6 },
  { t: "Onboarding flow polish", c: ["onboarding", "UX", "retention"], d: 37, m: 4 },
  { t: "Reduce activation drop-off", c: ["onboarding", "retention", "pricing"], d: 35, m: 8 },
  { t: "Knowledge graph schema", c: ["knowledge graph", "Postgres", "embeddings"], d: 33, m: 6 },
  { t: "Choosing an embedding model", c: ["embeddings", "RAG", "Gemini"], d: 30, m: 5 },
  { t: "RAG vs fine-tuning", c: ["RAG", "embeddings", "Claude"], d: 28, m: 7 },
  { t: "React state management", c: ["React", "UX"], d: 26, m: 3 },
  { t: "Auth gate with Google", c: ["auth", "React", "latency"], d: 24, m: 5 },
  { t: "Postgres + pgvector setup", c: ["Postgres", "embeddings", "knowledge graph"], d: 22, m: 6 },
  { t: "Cutting LLM latency", c: ["latency", "caching", "Claude"], d: 19, m: 8 },
  { t: "Prompt caching strategy", c: ["caching", "Claude", "latency"], d: 17, m: 5 },
  { t: "Gemini vs Claude for chat", c: ["Gemini", "Claude", "pricing"], d: 14, m: 9 },
  { t: "Roadmap for Q3", c: ["roadmap", "hiring", "positioning"], d: 12, m: 6 },
  { t: "Hiring a founding engineer", c: ["hiring", "fundraising"], d: 9, m: 4 },
  { t: "Fundraise narrative", c: ["fundraising", "positioning", "roadmap"], d: 7, m: 7 },
  { t: "Retention experiments", c: ["retention", "onboarding", "pricing"], d: 4, m: 6 },
  { t: "Knowledge graph UI", c: ["knowledge graph", "UX", "React"], d: 2, m: 5 },
  { t: "Hot topics dashboard", c: ["knowledge graph", "UX", "embeddings"], d: 1, m: 4 },
];

app.post("/api/profiles/:pid/mock", withProfile, (req, res) => {
  const DAY = 86_400_000;
  const now = Date.now();
  // Idempotent: clear any prior mock set first (cascades to messages).
  req.db.prepare("DELETE FROM conversations WHERE id LIKE 'mk-%'").run();

  const insConv = req.db.prepare(
    "INSERT INTO conversations (id, title, created_at, updated_at, model, concepts, pinned) VALUES (?,?,?,?,?,?,0)",
  );
  const insMsg = req.db.prepare(
    "INSERT INTO messages (id, conversation_id, role, content, ts, model, context_used, seq, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );

  MOCK_SET.forEach((item, i) => {
    const id = `mk-${i + 1}`;
    const created = now - item.d * DAY + 10 * 3_600_000; // ~10am that day
    const updated = created + item.m * 4 * 60_000;
    insConv.run(id, item.t, created, updated, "claude-opus-4-8", JSON.stringify(item.c));
    for (let j = 0; j < item.m; j++) {
      const role = j % 2 === 0 ? "user" : "assistant";
      const content =
        role === "user"
          ? `About "${item.t}" — point ${j / 2 + 1}?`
          : `Here's my take on ${item.c[j % item.c.length]} for that.`;
      insMsg.run(
        `${id}-m${j}`,
        id,
        role,
        content,
        created + j * 60_000,
        role === "assistant" ? "claude-opus-4-8" : null,
        null,
        j,
        role === "assistant" ? 120 : 30,
        role === "assistant" ? 90 : 0,
      );
    }
  });

  res.json({ imported: MOCK_SET.length });
});

// --- import Claude.ai export (bootstrap history) ---------------------------

app.post("/api/profiles/:pid/import", withProfile, (req, res) => {
  try {
    const stats = importClaudeExport(req.db, req.body);
    res.json(stats);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Import a Claude export already on disk under personal-claude/exports/, and
// create an auto-summary Note per conversation from the export's own summary
// (no LLM). Returns the imported conversation ids for the triage pass.
const REPO_ROOT = join(__dirname, "..", "..");
function resolveExportFile(rel) {
  const dir = resolve(REPO_ROOT, String(rel || ""));
  if (!dir.startsWith(join(REPO_ROOT, "exports"))) {
    throw Object.assign(new Error("dir must be under exports/"), { code: 400 });
  }
  const file = join(dir, "conversations.json");
  if (!existsSync(file)) throw Object.assign(new Error("conversations.json not found"), { code: 404 });
  return file;
}

// Mirror a profile's long-term memory to a human-readable bio file under
// personal-claude/bio/<name>_ltm.md (git-ignored). Best-effort.
const BIO_DIR = join(REPO_ROOT, "bio");
function syncBio(pid) {
  try {
    const prow = systemDb.prepare("SELECT name FROM profiles WHERE id=?").get(pid);
    const name = prow?.name || pid;
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || pid;
    const ltm = readMemFile(pid, LTM_FILE).content;
    mkdirSync(BIO_DIR, { recursive: true });
    writeFileSync(
      join(BIO_DIR, `${slug}_ltm.md`),
      `# ${name} — Long-term memory\n\n_Synced ${new Date().toISOString().slice(0, 10)} from this profile's LTM._\n\n${ltm || "_(empty)_"}\n`,
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

// Ensure a family-relations markdown exists for a profile (template; never
// overwrites an existing one so hand-written content is preserved).
function syncFamily(pid) {
  try {
    const prow = systemDb.prepare("SELECT name FROM profiles WHERE id=?").get(pid);
    const name = prow?.name || pid;
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || pid;
    mkdirSync(BIO_DIR, { recursive: true });
    const file = join(BIO_DIR, `${slug}_family.md`);
    if (existsSync(file)) return; // keep hand-edited content
    writeFileSync(
      file,
      `# ${name} — Family relations\n\n` +
        `_Personal context for the assistant. Fill in what's relevant._\n\n` +
        `## Immediate family\n` +
        `- **Partner / spouse:** \n` +
        `- **Children:** \n` +
        `- **Parents:** \n` +
        `- **Siblings:** \n\n` +
        `## Extended family\n` +
        `- \n\n` +
        `## Important dates\n` +
        `- \n\n` +
        `## Notes\n` +
        `- \n`,
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

// Write every profile's current LTM + ensure a family file in the bio folder.
app.post("/api/maintenance/sync-bios", (req, res) => {
  try {
    const rows = systemDb.prepare("SELECT id, name FROM profiles").all();
    for (const { id } of rows) {
      syncBio(id);
      syncFamily(id);
    }
    res.json({ ok: true, synced: rows.map((r) => r.name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Resolve an export FOLDER under exports/ (for non-Claude engine imports).
function resolveExportDir(rel) {
  const dir = resolve(REPO_ROOT, String(rel || ""));
  if (!dir.startsWith(join(REPO_ROOT, "exports"))) {
    throw Object.assign(new Error("dir must be under exports/"), { code: 400 });
  }
  if (!existsSync(dir)) throw Object.assign(new Error("export folder not found"), { code: 404 });
  return dir;
}

// Import a ChatGPT or Gemini export folder, tagging each conversation's source.
app.post("/api/profiles/:pid/import-engine", withProfile, (req, res) => {
  try {
    const engine = String(req.body?.engine || "").toLowerCase();
    if (engine !== "chatgpt" && engine !== "gemini")
      return res.status(400).json({ error: "engine must be 'chatgpt' or 'gemini'" });
    const dir = resolveExportDir(req.body?.dir);
    const onlyIds =
      Array.isArray(req.body?.ids) && req.body.ids.length ? new Set(req.body.ids) : null;
    const convs = parseEngineDir(engine, dir);
    const stats = importNormalized(req.db, engine, convs, onlyIds);
    res.json({
      imported: stats.imported,
      skipped: stats.skipped,
      messages: stats.messages,
      ids: stats.items.map((i) => i.id),
      items: stats.items.map((i) => ({ id: i.id, title: i.title })),
    });
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

// Maintenance: permanently remove all generated mock/showcase data (id LIKE
// 'mk-%' conversations + their messages, notes, reminders and memory) across
// every profile. Showcase chats are throwaway, so this is a hard delete.
app.post("/api/maintenance/clear-mock", (req, res) => {
  try {
    const rows = systemDb.prepare("SELECT id FROM profiles").all();
    const result = [];
    for (const { id } of rows) {
      const db = getProfileDb(id);
      const n = db.prepare("SELECT COUNT(*) n FROM conversations WHERE id LIKE 'mk-%'").get().n;
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM messages WHERE conversation_id LIKE 'mk-%'").run();
        db.prepare("DELETE FROM notes WHERE conversation_id LIKE 'mk-%'").run();
        db.prepare("DELETE FROM reminders WHERE conversation_id LIKE 'mk-%'").run();
        db.prepare("DELETE FROM memory WHERE conversation_id LIKE 'mk-%'").run();
        db.prepare("DELETE FROM conversations WHERE id LIKE 'mk-%'").run();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      if (n) result.push({ profile: id, removed: n });
    }
    res.json({ ok: true, cleared: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Peek: list the conversations in an on-disk export WITHOUT importing — for
// per-conversation profile assignment. Not profile-scoped (auth gate applies).
app.post("/api/import/peek", (req, res) => {
  try {
    const data = JSON.parse(readFileSync(resolveExportFile(req.body?.dir), "utf8"));
    const list = Array.isArray(data) ? data : data.conversations || [];
    res.json({
      items: list.map((c) => ({
        uuid: c.uuid || c.id,
        name: (c.name || c.title || "Untitled").slice(0, 120),
        summary: String(c.summary || "").slice(0, 200),
        messages: (c.chat_messages || c.messages || []).length,
        createdAt: Date.parse(c.created_at) || 0,
      })),
    });
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message });
  }
});

app.post("/api/profiles/:pid/import-export", withProfile, (req, res) => {
  try {
    const file = resolveExportFile(req.body?.dir);
    const onlyIds =
      Array.isArray(req.body?.ids) && req.body.ids.length ? new Set(req.body.ids) : null;
    const data = JSON.parse(readFileSync(file, "utf8"));
    const stats = importClaudeExport(req.db, data, onlyIds);

    // auto-summary note per imported conversation (from the export's summary)
    // + persist it as conversation metadata so it surfaces everywhere.
    const insNote = req.db.prepare(
      "INSERT INTO notes (id, conversation_id, title, body, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    );
    const setSum = req.db.prepare(
      "UPDATE conversations SET summary=?, subject=? WHERE id=?",
    );
    const now = Date.now();
    for (const it of stats.items) {
      if (it.summary) {
        insNote.run(uid("n"), it.id, it.title.slice(0, 60), it.summary, now, now);
        setSum.run(it.summary, it.title.slice(0, 80), it.id);
        writeConvMeta(req.pid, it.id, { subject: it.title.slice(0, 80), summary: it.summary });
      }
    }
    res.json({
      imported: stats.imported,
      skipped: stats.skipped,
      messages: stats.messages,
      ids: stats.items.map((i) => i.id),
      items: stats.items.map((i) => ({ id: i.id, title: i.title })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Triage a batch of imported conversations with ONE batched LLM call:
// extract topics, a reminder takeaway if there's a concrete open action, and
// whether it's worth long-term memory. Applies the results.
app.post("/api/profiles/:pid/process-batch", withProfile, async (req, res) => {
  const prow = systemDb.prepare("SELECT * FROM profiles WHERE id=?").get(req.pid);
  const model = prow?.default_model || "claude-opus-4-8";
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 20) : [];
  if (!ids.length) return res.json({ processed: 0, reminders: 0, memorized: 0 });

  // gather title + summary (from the auto-summary note) for each id
  const noteFor = req.db.prepare(
    "SELECT body FROM notes WHERE conversation_id=? ORDER BY created_at LIMIT 1",
  );
  const convFor = req.db.prepare("SELECT title, concepts, updated_at FROM conversations WHERE id=?");
  const batch = [];
  for (const id of ids) {
    const conv = convFor.get(id);
    if (!conv) continue;
    const note = noteFor.get(id);
    batch.push({ id, title: conv.title, summary: (note?.body || "").slice(0, 600) });
  }
  if (!batch.length) return res.json({ processed: 0, reminders: 0, memorized: 0 });

  let parsed = [];
  try {
    const raw = await runModel(
      model,
      "You triage imported chat summaries. For EACH item return an object: " +
        '{"i": <index>, "topics": ["2-4 short labels"], "reminder": {"text":"...","dueInDays":1-30} | null, "memoryWorthy": true|false}. ' +
        "reminder: only when there is a concrete unfinished action worth following up; otherwise null. " +
        "memoryWorthy: true only for durable interests, decisions, or facts worth long-term memory (not trivia). " +
        "Respond ONLY with a JSON array, same order as input.",
      [
        {
          role: "user",
          content:
            "Items:\n" +
            batch.map((b, i) => `${i}. ${b.title}\n   ${b.summary}`).join("\n") +
            "\n\nReturn the JSON array.",
        },
      ],
    );
    const m = raw.match(/\[[\s\S]*\]/);
    parsed = JSON.parse(m ? m[0] : raw);
  } catch {
    parsed = [];
  }

  let reminders = 0;
  let memorized = 0;
  const results = [];
  const setConcepts = req.db.prepare("UPDATE conversations SET concepts=? WHERE id=?");
  const setSum = req.db.prepare("UPDATE conversations SET summary=?, subject=? WHERE id=?");
  const insRem = req.db.prepare(
    "INSERT INTO reminders (id, text, due_at, done, conversation_id) VALUES (?,?,?,0,?)",
  );
  const insMem = req.db.prepare(
    "INSERT INTO memory (id, conversation_id, subject, body, created_at) VALUES (?,?,?,?,?)",
  );
  batch.forEach((b, i) => {
    const r = parsed[i] || {};
    const topics = Array.isArray(r.topics) ? r.topics.map((t) => String(t).trim()).filter(Boolean) : [];
    if (topics.length) {
      const existing = JSON.parse(convFor.get(b.id)?.concepts || "[]");
      const merged = [...new Set([...existing, ...topics])].slice(0, 8);
      setConcepts.run(JSON.stringify(merged), b.id);
    }
    if (b.summary) setSum.run(b.summary, b.title.slice(0, 80), b.id);
    const hasReminder = !!(r.reminder && r.reminder.text);
    if (hasReminder) {
      const days = Math.min(30, Math.max(1, Number(r.reminder.dueInDays) || 3));
      insRem.run(uid("r"), String(r.reminder.text).slice(0, 160), Date.now() + days * 86_400_000, b.id);
      reminders++;
    }
    if (r.memoryWorthy) {
      insMem.run(uid("mem"), b.id, b.title.slice(0, 80), b.summary, Date.now());
      memorized++;
    }
    // persist a per-conversation digest (STM/LTM contribution) for later storage sync
    writeDigest(req.pid, b.id, {
      id: b.id,
      title: b.title,
      summary: b.summary,
      topics,
      reminder: hasReminder ? { text: r.reminder.text, dueInDays: r.reminder.dueInDays } : null,
      memoryWorthy: !!r.memoryWorthy,
    });
    results.push({
      id: b.id,
      topics: topics.length,
      reminder: hasReminder,
      memorized: !!r.memoryWorthy,
    });
  });

  res.json({ processed: batch.length, reminders, memorized, results });
});

// --- boot ------------------------------------------------------------------

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Personal Claude backend on http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_PATHS.DATA_DIR}`);
  console.log(`Claude key: ${hasAnthropicKey() ? "loaded ✓" : "missing ✗"}`);
  console.log(`Gemini key: ${hasGeminiKey() ? "loaded ✓" : "missing ✗"}`);
  console.log(`Google login gate: ${authConfigured() ? "ON ✓" : "off (open mode)"}`);
  console.log(`Gmail/Calendar sync: ${gws.workspaceConfigured() ? "ready ✓" : "off (set GOOGLE_CLIENT_SECRET)"}`);
  startDailyScheduler();
});
