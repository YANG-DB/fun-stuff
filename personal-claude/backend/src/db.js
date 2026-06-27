import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SEED_PROFILES, buildSeedForProfile } from "./seed.js";

// Storage layout (outside the repo, per the chosen location):
//   ~/.personal-claude/
//     system.db            cross-cutting: profile registry, settings
//     profiles/
//       <profileId>.db      one isolated DB file per profile
//
// File-per-profile gives physical isolation, per-profile backup/delete (rm the
// file), and independent write locks. system.db holds only cross-profile data.

const DATA_DIR =
  process.env.PERSONAL_CLAUDE_DATA_DIR || join(homedir(), ".personal-claude");
const PROFILES_DIR = join(DATA_DIR, "profiles");

mkdirSync(PROFILES_DIR, { recursive: true });

function tune(db) {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

// --- system.db -------------------------------------------------------------

export const systemDb = tune(new DatabaseSync(join(DATA_DIR, "system.db")));

systemDb.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    tagline       TEXT NOT NULL DEFAULT '',
    persona       TEXT NOT NULL DEFAULT '',
    avatar        TEXT NOT NULL DEFAULT '',
    color         TEXT NOT NULL DEFAULT '#888888',
    default_model TEXT NOT NULL,
    budget_usd    REAL NOT NULL DEFAULT 0,
    spent_usd     REAL NOT NULL DEFAULT 0,
    google        TEXT,
    allowed_emails TEXT NOT NULL DEFAULT '[]',
    settings      TEXT NOT NULL DEFAULT '{}'
  );
`);

// Upgrade a profiles table created before these columns existed.
for (const col of [
  "allowed_emails TEXT NOT NULL DEFAULT '[]'",
  "settings TEXT NOT NULL DEFAULT '{}'",
]) {
  try {
    systemDb.exec(`ALTER TABLE profiles ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}

function seedSystem() {
  const count = systemDb.prepare("SELECT COUNT(*) n FROM profiles").get().n;
  if (count > 0) return;
  const ins = systemDb.prepare(`
    INSERT INTO profiles
      (id, name, tagline, persona, avatar, color, default_model, budget_usd, spent_usd, google)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const p of SEED_PROFILES) {
    ins.run(
      p.id, p.name, p.tagline, p.persona, p.avatar, p.color,
      p.default_model, p.budget_usd, p.spent_usd,
      p.google ? JSON.stringify(p.google) : null,
    );
  }
}

// ---- profiles.md: human-readable, canonical storage for profiles ----------
// The DB is the query index; profiles.md is written on every change and
// reloaded on startup. The fenced ```json block per profile is the source of
// truth on read.

const PROFILES_MD = join(DATA_DIR, "profiles.md");

function safeArr(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function writeProfilesMd() {
  const rows = systemDb.prepare("SELECT * FROM profiles ORDER BY rowid").all();
  let md =
    "# Personal Claude — Profiles\n\n" +
    "<!-- Storage for the profiles feature. Auto-generated on every change and reloaded on restart.\n" +
    "     The ```json block under each profile is the source of truth. -->\n\n";
  for (const r of rows) {
    const allowed = safeArr(r.allowed_emails);
    const google = r.google ? JSON.parse(r.google) : null;
    let settings = {};
    try {
      settings = JSON.parse(r.settings || "{}");
    } catch {
      /* keep {} */
    }
    const rec = {
      id: r.id,
      name: r.name,
      tagline: r.tagline,
      persona: r.persona,
      avatar: r.avatar,
      color: r.color,
      defaultModel: r.default_model,
      budgetUsd: r.budget_usd,
      spentUsd: r.spent_usd,
      google,
      allowedEmails: allowed,
      settings,
    };
    md += `## ${r.avatar || ""} ${r.name}  \`${r.id}\`\n\n`;
    md += `- **Tagline:** ${r.tagline || "—"}\n`;
    md += `- **Model:** ${r.default_model}\n`;
    md += `- **Budget:** $${r.budget_usd} (spent $${r.spent_usd})\n`;
    md += `- **Access:** ${allowed.length ? allowed.join(", ") : "open to any signed-in user"}\n`;
    md += `- **Google:** ${google ? google.email : "—"}\n\n`;
    if (r.persona) md += `> ${String(r.persona).replace(/\n/g, "\n> ")}\n\n`;
    md += "```json\n" + JSON.stringify(rec, null, 2) + "\n```\n\n";
  }
  writeFileSync(PROFILES_MD, md);
}

function readProfilesMd() {
  if (!existsSync(PROFILES_MD)) return [];
  const text = readFileSync(PROFILES_MD, "utf8");
  const recs = [];
  const re = /```json\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      recs.push(JSON.parse(m[1]));
    } catch {
      /* skip malformed block */
    }
  }
  return recs;
}

function titleCaseFromId(id) {
  return (
    id
      .replace(/^p-/, "")
      .replace(/-[a-z0-9]{4,7}$/, "") // strip the random suffix
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || id
  );
}

// Re-register any profile whose data file exists on disk but isn't in the
// index — so a profile (and its conversations/memory) can never be orphaned by
// a missing/corrupt profiles.md. Uses seed data when the id is a known seed.
function recoverOrphanProfiles() {
  let files = [];
  try {
    files = readdirSync(PROFILES_DIR).filter((f) => f.endsWith(".db"));
  } catch {
    return;
  }
  const ins = systemDb.prepare(`
    INSERT INTO profiles
      (id, name, tagline, persona, avatar, color, default_model, budget_usd, spent_usd, google, allowed_emails)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')
  `);
  for (const f of files) {
    const id = f.replace(/\.db$/, "");
    if (systemDb.prepare("SELECT 1 FROM profiles WHERE id=?").get(id)) continue;
    const seed = SEED_PROFILES.find((p) => p.id === id);
    ins.run(
      id,
      seed?.name || titleCaseFromId(id),
      seed?.tagline || "Recovered profile",
      seed?.persona || "",
      seed?.avatar || "🧑",
      seed?.color || "#7C6FF0",
      seed?.default_model || "claude-opus-4-8",
      seed?.budget_usd || 0,
      seed?.spent_usd || 0,
      seed?.google ? JSON.stringify(seed.google) : null,
    );
  }
}

function initProfiles() {
  const recs = readProfilesMd();
  if (recs.length) {
    // Load from profiles.md (authoritative for the records it contains) via
    // UPSERT — never destructively delete, so a profile missing from the file
    // is preserved rather than wiped.
    const ins = systemDb.prepare(`
      INSERT OR REPLACE INTO profiles
        (id, name, tagline, persona, avatar, color, default_model, budget_usd, spent_usd, google, allowed_emails, settings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const p of recs) {
      if (!p || !p.id) continue;
      ins.run(
        p.id,
        p.name || "",
        p.tagline || "",
        p.persona || "",
        p.avatar || "🧑",
        p.color || "#7C6FF0",
        p.defaultModel || "claude-opus-4-8",
        Number(p.budgetUsd) || 0,
        Number(p.spentUsd) || 0,
        p.google ? JSON.stringify(p.google) : null,
        JSON.stringify(Array.isArray(p.allowedEmails) ? p.allowedEmails : []),
        JSON.stringify(p.settings && typeof p.settings === "object" ? p.settings : {}),
      );
    }
  } else {
    seedSystem();
  }
  recoverOrphanProfiles(); // re-register any orphaned data files
  writeProfilesMd(); // persist the canonical, healed state
}
initProfiles();

// --- per-profile DBs -------------------------------------------------------

const profileCache = new Map();

function migrateProfileDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS conversations (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT 'New chat',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      model      TEXT NOT NULL,
      concepts   TEXT NOT NULL DEFAULT '[]',
      pinned     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      ts              INTEGER NOT NULL,
      model           TEXT,
      context_used    TEXT,
      seq             INTEGER,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, ts);

    CREATE TABLE IF NOT EXISTS notes (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT,
      title           TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id              TEXT PRIMARY KEY,
      text            TEXT NOT NULL,
      due_at          INTEGER NOT NULL,
      done            INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT
    );

    CREATE TABLE IF NOT EXISTS memory (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT,
      subject         TEXT NOT NULL DEFAULT '',
      body            TEXT NOT NULL DEFAULT '',
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integrations (
      provider     TEXT PRIMARY KEY,
      data         TEXT NOT NULL DEFAULT '{}',
      connected_at INTEGER,
      last_sync    INTEGER
    );

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      name        TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 1,
      last_run    INTEGER,
      last_result TEXT
    );

    CREATE TABLE IF NOT EXISTS emails (
      id        TEXT PRIMARY KEY,
      ts        INTEGER,
      from_addr TEXT,
      subject   TEXT,
      snippet   TEXT,
      source    TEXT NOT NULL DEFAULT 'gmail'
    );
  `);

  // Upgrade DBs created before token tracking existed.
  for (const col of ["input_tokens", "output_tokens"]) {
    try {
      db.exec(`ALTER TABLE messages ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    } catch {
      /* column already exists */
    }
  }
  // Upgrade DBs created before conversation summary metadata existed.
  for (const col of ["summary", "subject"]) {
    try {
      db.exec(`ALTER TABLE conversations ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    } catch {
      /* column already exists */
    }
  }
  // Source engine label (claude | chatgpt | gemini) for imported conversations.
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'claude'");
  } catch {
    /* column already exists */
  }
  // Soft-delete: hide from the UI without destroying data (0 = visible).
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  } catch {
    /* column already exists */
  }
  // Recurrence for reminders/events (none | daily | weekly | monthly | yearly).
  try {
    db.exec("ALTER TABLE reminders ADD COLUMN repeat TEXT NOT NULL DEFAULT 'none'");
  } catch {
    /* column already exists */
  }
  // Provenance for reminders synced from Gmail/Calendar (dedupe + labelling).
  try {
    db.exec("ALTER TABLE reminders ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
  } catch {
    /* column already exists */
  }
  try {
    db.exec("ALTER TABLE reminders ADD COLUMN source_ref TEXT");
  } catch {
    /* column already exists */
  }
}

function seedProfileDb(db, profileId) {
  const seeded = db.prepare("SELECT value FROM meta WHERE key='seeded'").get();
  if (seeded) return;
  const data = buildSeedForProfile(profileId, Date.now());

  const insConv = db.prepare(`
    INSERT INTO conversations (id, title, created_at, updated_at, model, concepts, pinned)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, ts, model, context_used, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const c of data.conversations) {
    insConv.run(c.id, c.title, c.created_at, c.updated_at, c.model,
      JSON.stringify(c.concepts), c.pinned);
    c.messages.forEach((m, i) =>
      insMsg.run(m.id, c.id, m.role, m.content, m.ts, m.model ?? null, null, i),
    );
  }

  const insNote = db.prepare(`
    INSERT INTO notes (id, conversation_id, title, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const n of data.notes)
    insNote.run(n.id, n.conversation_id, n.title, n.body, n.created_at, n.updated_at);

  const insRem = db.prepare(`
    INSERT INTO reminders (id, text, due_at, done, conversation_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const r of data.reminders)
    insRem.run(r.id, r.text, r.due_at, r.done, r.conversation_id);

  db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', '1')").run();
}

/** Open (and lazily create + seed) the DB file for a profile. */
export function getProfileDb(profileId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) {
    throw new Error("invalid profile id");
  }
  if (profileCache.has(profileId)) return profileCache.get(profileId);

  const fresh = !existsSync(join(PROFILES_DIR, `${profileId}.db`));
  const db = tune(new DatabaseSync(join(PROFILES_DIR, `${profileId}.db`)));
  migrateProfileDb(db);
  if (fresh || !db.prepare("SELECT value FROM meta WHERE key='seeded'").get()) {
    seedProfileDb(db, profileId);
  }
  profileCache.set(profileId, db);
  return db;
}

export function profileExists(profileId) {
  return !!systemDb.prepare("SELECT 1 FROM profiles WHERE id=?").get(profileId);
}

/** Close and remove a profile's DB file (used when deleting a profile). */
export function deleteProfileDb(profileId) {
  const db = profileCache.get(profileId);
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    profileCache.delete(profileId);
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(join(PROFILES_DIR, `${profileId}.db${suffix}`));
    } catch {
      /* file may not exist */
    }
  }
}

export const DATA_PATHS = { DATA_DIR, PROFILES_DIR };
