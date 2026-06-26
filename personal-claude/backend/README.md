# Personal Claude — Backend

The gateway + persistence layer. Owns the SQLite databases and the server-side
LLM key; the frontend talks to it only through `/api`.

## Stack

- **Node + Express** (ESM), no build step
- **`node:sqlite`** (built into Node ≥ 22) — zero native dependencies
- **Gemini** chat via the server-side key (read from `../​.env`)

## Storage: file-per-profile

```
~/.personal-claude/                 (outside the repo)
  system.db                         profile registry (cross-cutting)
  profiles/
    p-lior.db                       one isolated SQLite file per profile
    p-maya.db
    p-dev.db
```

Each profile DB holds `conversations`, `messages`, `notes`, `reminders`. This
gives physical isolation, per-profile backup/delete (`rm <id>.db`), and
independent write locks. Override the location with `PERSONAL_CLAUDE_DATA_DIR`.

Seed data is inserted once per fresh DB (tracked by a `meta.seeded` flag), so the
app looks identical to the standalone frontend on first run.

## Run

```bash
npm install
npm run dev      # http://localhost:8787  (auto-restarts on change)
```

Reads `personal-claude/.env` for:
- `GEMINI_API_KEY` (required for real Gemini chat) — stays server-side, never sent to the browser
- `GEMINI_MODEL` / `GEMINI_RAG_MODEL` (model names for pro / flash)
- `GEMINI_TEMPERATURE`, `PORT`

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/profiles` | list profiles (+ `chatCount`) |
| PATCH | `/api/profiles/:pid` | update persona / model / google link / budget |
| GET·POST | `/api/profiles/:pid/conversations` | list / create |
| PATCH·DELETE | `/api/profiles/:pid/conversations/:cid` | rename·pin / delete |
| POST | `…/conversations/:cid/messages` | append a message |
| PATCH | `…/messages/:mid` | update message content (streaming finalize) |
| GET·POST·PATCH·DELETE | `/api/profiles/:pid/notes[/:nid]` | notes CRUD |
| GET·POST·PATCH·DELETE | `/api/profiles/:pid/reminders[/:rid]` | reminders CRUD |
| POST | `/api/chat` | stream a reply (Gemini server-side; text deltas) |

## Notes / next steps

- **Claude models** need an `ANTHROPIC_API_KEY` (not configured) — the gateway
  returns a clear message for them; Gemini models chat for real.
- This is where the **LiteLLM proxy** slots in later (one shared key, per-profile
  budgets/usage) — `/api/chat` would forward to it instead of calling Gemini
  directly.
- Future phases (headroom compression, embeddings, the knowledge graph) attach
  to these same per-profile DB files (e.g. a `sqlite-vec` table per profile).
