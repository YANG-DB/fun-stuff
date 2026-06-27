# Personal Claude — Features

A local-first, multi-profile AI chat workspace. One AI account (Claude / Gemini),
many profiles, each with its own isolated history, memory, notes, reminders and
knowledge graph — plus import from Claude / ChatGPT / Gemini exports, layered
memory, and rich exploration views.

- **Frontend:** Vite + React + TypeScript (port 3000) — [`frontend/`](frontend/)
- **Backend:** Node + Express (ESM) + `node:sqlite` (zero native deps), port 8787 — [`backend/`](backend/)
- **Data:** file-per-profile SQLite + markdown/JSON under `~/.personal-claude/` (outside the repo)

---

## Table of contents
1. [Architecture & data layout](#1-architecture--data-layout)
2. [Profiles & authentication](#2-profiles--authentication)
3. [Chat gateway](#3-chat-gateway)
4. [System prompt & dynamic date](#4-system-prompt--dynamic-date)
5. [Layered memory](#5-layered-memory)
6. [Personal details → LTM](#6-personal-details--ltm)
7. [Context suggestions & right-click lookup](#7-context-suggestions--right-click-lookup)
8. [Conversations: summaries & export](#8-conversations-summaries--export)
9. [Importing archives (Claude / ChatGPT / Gemini)](#9-importing-archives)
10. [Triage pipeline](#10-triage-pipeline)
11. [Organizing chats](#11-organizing-chats)
12. [Explore visualizations](#12-explore-visualizations)
13. [Clusters](#13-clusters)
14. [Pipeline view](#14-pipeline-view)
15. [Reminders & calendar events](#15-reminders--calendar-events)
16. [Gmail & Calendar sync](#16-gmail--calendar-sync)
17. [Scheduled daily tasks](#17-scheduled-daily-tasks)
18. [Notes & saved memory](#18-notes--saved-memory)
19. [Slash commands](#19-slash-commands)
20. [Tool / API reference](#20-tool--api-reference)
21. [Privacy, secrets & git hygiene](#21-privacy-secrets--git-hygiene)

---

## 1. Architecture & data layout

Everything a profile owns is split between a SQLite DB and human-readable files,
all under `~/.personal-claude/` (never in the repo):

```
~/.personal-claude/
  system.db                     # profile registry (id, name, settings, allowed_emails, google)
  profiles.md                   # canonical human-readable profile list (authoritative on restart)
  profiles/<pid>.db             # per-profile: conversations, messages, notes, reminders,
                                #   memory, integrations (Google), scheduled_tasks, emails
  context/<pid>.md              # curated <user_context> (hand-edited)
  memory/<pid>/
    STM.md                      # short-term memory (recent, time-relevant)
    LTM.md                      # long-term memory (durable; holds the Personal-details block)
    details.json                # structured personal details (name, socials, websites…)
    digests/<cid>.json          # per-conversation triage digest (staged for storage sync)
    conversations/<cid>.json    # per-conversation summary metadata (staged for storage sync)
    <memory-tool files>         # files the Claude memory tool created
```

Per-profile DBs make profiles fully isolated and portable. `profiles.md` is
non-destructively reconciled on startup (UPSERT + orphan recovery), so a profile
is never silently lost.

---

## 2. Profiles & authentication

- **Multi-profile** "Who's chatting?" gate; create/switch/manage profiles
  ([`ProfileGate`](frontend/src/components/ProfileGate.tsx),
  [`ProfileSettings`](frontend/src/components/ProfileSettings.tsx)).
- **Google login gate** (identity only — no Drive/Gmail/Calendar scopes): frontend
  GIS → backend verifies the ID token → issues a session JWT (Bearer on every
  `/api` call). Configured via `GOOGLE_CLIENT_ID` + `JWT_SECRET`; runs in demo
  mode without them.
- **Per-profile access control:** an optional allowed-emails list restricts a
  profile to specific Google accounts (empty = open to anyone signed in).
- **Per-profile settings:** default model, thinking, effort, web tools, memory
  tool, persona — all editable in a wide two-column ⚙ settings dialog.
- **Full-profile export** (⚙ → Export data → Full profile): **JSON / Markdown /
  PDF** bundling meta, personal details, user context, LTM/STM, memory, notes,
  reminders, and a conversations index.
- **Token counters:** per-conversation and aggregate-per-profile token usage.
- **Resizable left panel:** the chats panel toggles between **full screen**,
  the normal pane, and **hidden** (a floating ☰ reveals it again).

---

## 3. Chat gateway

`POST /api/chat` streams **newline-delimited JSON** events
(`text` · `thinking` · `tool` · `sources` · `done`) parsed by
[`chatService`](frontend/src/services/chatService.ts). The runner
[`anthropic.js`](backend/src/anthropic.js) drives the tool loop.

- **Models:** Claude `claude-opus-4-8` (default) and Gemini; selectable per chat.
- **Streaming** with live **thinking** panel (collapsible) and inline
  **🔍 tool-activity** lines; citations collected into a **Sources** footer.
- **Thinking + effort** — Opus 4.8 is *adaptive-thinking only*
  (`thinking:{type:"adaptive",display:"summarized"}`); a fixed `budget_tokens`
  returns 400. Depth is controlled with `output_config.effort`
  (`low|medium|high|xhigh`). Status shows in the chat header.
- **Prompt caching** — `cache_control:{type:"ephemeral"}` on the stable system
  block; the volatile date + STM blocks sit after the breakpoint so long sessions
  reuse the cached prefix.
- **Auto-title** from the first user message; **Summarize / Memorize** refine it.

---

## 4. System prompt & dynamic date

Assembled fresh on **every** request in
[`systemPrompt.js`](backend/src/systemPrompt.js):

- **Base template** (identity, prose-first formatting, step-by-step for code/math,
  "use web search for time-sensitive questions").
- A single editable `export const TONE`.
- The profile **persona**, then `<user_context>`, then `<long_term_memory>` (cached).
- A freshly computed **current date** + `<short_term_memory>` as trailing blocks
  **after** the cache breakpoint (so they never invalidate the cache).
- **Retrieved context** (see §7) appended as a `<retrieved_context>` block when the
  user attaches related items.

---

## 5. Layered memory

Four complementary layers:

| Layer | Where | How it's built |
|---|---|---|
| **`<user_context>`** | `context/<pid>.md` | hand-edited (⚙ → User context); always injected |
| **Memory tool** (optional) | `memory/<pid>/…` | model-driven `view/create/str_replace/insert/delete/rename`, client-executed in [`memory.js`](backend/src/memory.js), traversal-protected |
| **STM** (short-term) | `memory/<pid>/STM.md` | regenerated from recent activity (`POST …/stm`) — what you're working on now |
| **LTM** (long-term) | `memory/<pid>/LTM.md` | incrementally consolidated durable interests/projects (`POST …/ltm`); preserves the Personal-details block verbatim |

STM/LTM cards live in the sidebar; both feed the system prompt (LTM cached, STM
volatile). The **Memory tab** is a browse-only log of memorized conversation
summaries (distinct from the above).

---

## 6. Personal details → LTM

⚙ **Profile settings → Personal details** lets a profile record **name, location,
role, bio, websites, social accounts, and arbitrary custom fields**
(`GET/PUT /api/profiles/:pid/details`, stored in `details.json`). On save they're
rendered into a **managed block** at the top of `LTM.md`
(`<!-- PERSONAL_DETAILS -->…`), so the assistant always knows them — and the block
is **preserved verbatim** across LTM consolidation.

---

## 7. Context suggestions & right-click lookup

**Type-ahead context** ([`retrieveContext`](frontend/src/services/chatService.ts)):
as you draft a message, the app ranks your **past conversations, notes, and saved
memory** (title/topics ×3, body/summary ×1) and shows the best as **Suggested
context** chips. Click `＋` to add one (it moves to *Context added*). Added items
are sent with the message and injected server-side as `<retrieved_context>`
(conversation → title+topics+summary; note → title+body; memory → subject+body),
so the chat is genuinely grounded in those points.

**Right-click lookup** ([`WordLookup`](frontend/src/components/ChatView.tsx)):
right-click any word (or select a phrase) in a message → **Search context & web**
(`POST /api/profiles/:pid/lookup`). Returns:
- **In your context** — matching conversations / notes / memory (clickable to open).
- **From the web** — a concise grounded explanation + reference links, via Claude
  web search. The query is editable to refine.

---

## 8. Conversations: summaries & export

- **Summaries everywhere:** Summarize/Memorize (and import/triage) persist a
  `summary` + `subject` on the conversation and stage `conversations/<cid>.json`.
  The summary then shows in the **sidebar** (`✦` line), **graph node previews**,
  **cluster panels**, and a one-line **banner** atop the open chat (hover → full
  text). The **Summarize** button shows the existing summary with a
  **Recreate / update** action.
- **Per-chat export** (header **Export** menu): **Markdown**, **JSON**, or **PDF**
  (print-to-PDF window) — [`exportData.ts`](frontend/src/services/exportData.ts).
- **Workspace export** (⚙ → Export data): download **Everything / LTM / STM /
  Notes / Reminders / Memory** as markdown.

---

## 9. Importing archives

Import from three engines; every conversation is **labelled with its source**
(badge: Claude / GPT / Gemini), stored in `conversations.source`.

| Engine | Format | Parser |
|---|---|---|
| **Claude** | `conversations.json` | [`claudeImport.js`](backend/src/claudeImport.js) |
| **ChatGPT** | `conversations-*.json` (tree `mapping`) | [`engineImport.js`](backend/src/engineImport.js) |
| **Gemini** | Takeout `conversation_*.txt` (JSON turns) | [`engineImport.js`](backend/src/engineImport.js) |

The **Import Archive** flow ([`ImportArchive`](frontend/src/components/ImportArchive.tsx)):
- **Peek** an export without importing; assign **each conversation to a profile**
  (bulk-apply + filter), or send the whole batch to one profile / a new profile.
- **Per-conversation progress list** (pending → imported → done, with the triage
  outcome per row).
- **Pause / resume** the run, **cancel**, and **repeat triage** for selected rows.
- Endpoints: `POST /api/import/peek`, `…/import-export` (Claude),
  `…/import-engine` (ChatGPT/Gemini).

---

## 10. Triage pipeline

`POST /api/profiles/:pid/process-batch` runs one batched LLM pass over imported
conversations and applies, per conversation:
- **Topics** → merged into `concepts` (knowledge graph).
- **Reminder** → created when a concrete follow-up exists.
- **Memory-worthy** → consolidated into the memory log.
- **Summary** → persisted on the conversation + staged as `digests/<cid>.json`.

STM/LTM are rebuilt for affected profiles afterward.

---

## 11. Organizing chats

Sidebar ([`Sidebar`](frontend/src/components/Sidebar.tsx)):
- **Search** (title / summary / topics) and **Group by** date / subject / topic / length.
- **Filters:** by **source** (All/Claude/GPT/Gemini, with counts), **Hide empty**
  (no-message chats), and **Show deleted**.
- **Soft-delete** (mark, don't destroy): per-row trash/restore, plus **Select**
  mode for **bulk delete / restore** (`POST …/conversations/bulk-delete`). Deleted
  chats are hidden everywhere but recoverable.
- **Auto-tag Qs:** tags short one-off question chats (≤2 messages, single short
  user turn) with a **"quick question"** concept (`POST …/auto-tag`).
- **Expanded table view** (**Table** button): full-width sortable table — checkbox,
  title, source, summary, topics, messages, updated, open/delete — with the same
  filters and bulk actions.
- **Show in pipeline:** while on the Pipeline tab, a row action traces that chat in
  the pipeline.

---

## 12. Explore visualizations

[`Explore`](frontend/src/components/Explore.tsx) has five tabs. Soft-deleted and
empty conversations are excluded from all of them.

- **Calendar** — month grid of conversations + reminders; **hover a day → `＋`** to
  add a task/reminder (date + time + recurrence); recurring reminders expand across
  the month; an **All / 📅 Events / ✓ Tasks** filter shows/hides calendar events vs
  reminders.
- **This week** — day columns of the week, **in sync with the Calendar**: shows the
  week's reminders/events (recurrence-expanded), the same `＋` add per day, and the
  events/tasks filter.
- **Knowledge graph** — a **topic-rooted explorer**: pick a topic from a table,
  then see it centered with its **related topics** (co-occurring) and its
  **conversations**; click a related topic to re-center and walk outward, with
  **breadcrumbs** + back. Click a conversation to preview/open.
- **Topics** — topics as nodes sized by centrality (**defaults to the Table view**).
- **Pipeline** — the processing flow (see §14).

**Graph interactions** (Graph-Commons style): force-directed layout with
**pan / zoom / drag**, **fit-to-screen**, **spread**, a **timeline scrubber +
activity histogram** (temporal fade), flat color-by-cluster nodes, straight light
edges, and always-on labels.

**Graph ⇄ Table toggle** on the Topics view (and the Knowledge graph's topic
picker is itself a table). Tables are **grouped by cluster** with **collapsible
cluster rows** (a collapsed cluster shows one aggregate row), **sortable columns**
(click headers), and a **filter** box.

---

## 13. Clusters

Both graphs run **weighted label-propagation community detection** to group related
conversations / topics:

- Each cluster gets a **color** and an **on-map name label** (its most central
  concept/topic + count). **Hovering the label highlights** that cluster — members
  stay vivid, the rest fade, and a soft **ellipse** region is drawn around it.
- **Right-click** a node or cluster label → menu:
  - **Zoom into cluster** — re-lays-out *just* that cluster across the canvas
    (members fan out, shrink, and label themselves) and opens a panel listing the
    **distinct conversations inside**.
  - **Continue conversation** — starts a **new session seeded** with an
    LLM-synthesized continuity briefing across the cluster's conversations
    (`POST …/conversations/from-cluster`); the new chat inherits their concepts and
    opens immediately.

---

## 14. Pipeline view

A dynamic flow diagram with **two lanes converging on memory**:

```
Conversation → Summarize → Topics ─┬─→ Knowledge graph
                                   └─→ STM → LTM
   Gmail ┐                              ↑
Calendar ┴→ Reminders / tasks ─────────┘
```

- Each stage is a live card with a real metric (chats, summarized, topics, graph
  relations, email tasks, calendar events, open reminders, STM/LTM) and **animated
  flow particles** along edges.
- **Trace a conversation** (dropdown, or "Show in pipeline" from the sidebar):
  reached stages show ✓ / un-reached dim; a detail grid shows **that
  conversation's actual output at each stage** — summary, topics, the specific
  knowledge-graph relations (clickable), STM status, and the LTM entry.
- **Clickable nodes → content dialogs** (with a **← Back** button): **STM** / **LTM**
  render their markdown; **Reminders / tasks** shows the list (toggle complete);
  **Gmail** opens an **email browser** — the inbox digest, the stored **email list**
  (subject / sender / snippet / date), and the extracted ✉️ tasks. Topics / Knowledge
  graph / Calendar nodes navigate to their tabs.

---

## 15. Reminders & calendar events

- **Add** a task/event with **date + time** and a **recurrence** (none / daily /
  weekly / monthly / yearly) — from the **Reminders tab** or directly from the
  **Calendar** (hover a day → `＋`).
- **Recurring** reminders **roll forward** to the next occurrence when completed
  (in the list and in the due-popup); the Calendar **expands** all occurrences
  across the visible month.
- **Pop-up alerts** + browser notifications for due reminders, with **Done** and
  **Snooze 1h** ([`ReminderAlerts`](frontend/src/components/ReminderAlerts.tsx)).
- **Calendar sync:** per-reminder **`.ics`** download and **Add to Google
  Calendar** link.
- **Filter** the Reminders tab by **All / 📅 Events / ✓ Tasks** (by `source`).
- Reminders can be auto-extracted during triage, and synced from Gmail/Calendar (§16).

---

## 16. Gmail & Calendar sync

Each profile can connect its **own** Google account (read-only) to pull calendar
events and email action-items into its reminders — a per-profile daily briefing.
Direct Node integration ([`gworkspace.js`](backend/src/gworkspace.js)) — no extra
dependencies (server-side OAuth + REST over global `fetch`).

- **Connect** (⚙ → Gmail & Calendar): server-side **OAuth 2.0 authorization-code**
  flow with `gmail.readonly` + `calendar.readonly` + `openid email`, `access_type=
  offline`. The **refresh token is stored AES-256-GCM-encrypted** (key derived from
  `JWT_SECRET`) in the profile's `integrations` table; **Disconnect** revokes it.
- **Sync** (`POST …/google/sync`, or **Sync now**):
  - **Calendar** → next 14 days of events become reminders (📅), deduped by
    event-instance (`source_ref = gcal:<id>:<start>`).
  - **Gmail** → recent mail (`newer_than:2d -category:promotions`) is LLM-triaged
    into **action-item reminders** (✉️, deduped per message `gmail:<id>`) plus a
    daily **inbox digest** saved as a note.
- Reminders carry `source` (`manual` / `gcal` / `gmail`) + `source_ref` for dedup.
- Synced **emails are stored** (per-profile `emails` table) and browsable in the
  Pipeline's **Gmail** panel (§14).

**Offline test (no API needed):** ⚙ → Gmail & Calendar → **Import & test** reads a
**Google Takeout** folder under `exports/` — Calendar `.ics` + Gmail `.mbox` — and
runs the *same* pipeline (events → reminders, emails → tasks + digest + stored
email list). Email is windowed to the **recent month** (reads the whole bounded
file, sorts by Date, falls back to newest when the export predates the window), so
you don't need to export your whole history.

**One-time Google Cloud setup (for live sync):** enable the **Gmail API** +
**Calendar API**, add `http://localhost:8787/api/google/callback` as an Authorized
redirect URI, and add the two scopes + your account as a **test user** on the
consent screen (unverified app; sensitive Gmail scope needs Google verification
before public use). Set `GOOGLE_CLIENT_SECRET` (and optionally `GOOGLE_REDIRECT_URI`).

Endpoints: `POST …/google/auth-url`, `GET /api/google/callback`,
`GET …/integrations`, `POST …/google/sync`, `POST …/google/import-export`,
`DELETE …/google`, `GET …/emails`.

---

## 17. Scheduled daily tasks

A per-profile **job framework** (not just sync) that runs daily — and on demand.
Toggle which jobs run; each records last-run + result.

- **Built-in jobs:** `google-sync` (Gmail + Calendar → reminders/digest, §16),
  `refresh-stm` (regenerate short-term memory), `daily-briefing` (an LLM-written
  **🗞️ Daily briefing** note: today + what needs attention, from reminders + STM +
  recent activity).
- **UI** (⚙ → Scheduled daily tasks): enable/disable each job, **▶ Run now** per job,
  **Run all now**, and each row's last-run time + result.
- **Scheduler:** hourly tick runs any enabled job not run in ~20h
  (`startDailyScheduler`); state in the per-profile `scheduled_tasks` table.
- **Extensible:** add a capability with one entry in the `JOBS` map
  (`{ label, run: async(pid) => result }`) — e.g. weekly LTM consolidation, an
  analysis report, or overdue-reminder nudges.

Endpoints: `GET …/tasks`, `PATCH …/tasks/:name`, `POST …/tasks/:name/run`,
`POST …/tasks/run-all`.

---

## 18. Notes & saved memory

- **Notes** — save any assistant message (or summary) as a note; browse in the
  Notes tab; jump back to the source conversation.
- **Saved memory** — memorized conversation summaries (subject + body), browsable
  in the Memory tab. Both feed context suggestions (§7) and the lookup (§7).

---

## 19. Slash commands

Typed in the composer:

`/think on|off` · `/effort low|medium|high|xhigh` · `/web on|off` ·
`/memory on|off` · `/context` · `/reload-context` · `/help`

---

## 20. Tool / API reference

| Purpose | Type string | Execution |
|---|---|---|
| Default model | `claude-opus-4-8` | — |
| Web search | `web_search_20260209` | server-side |
| Web fetch | `web_fetch_20260209` | server-side |
| Memory (optional) | `memory_20250818` | client-side (loop in `memory.js`) |

> A newer `web_search_20260318` exists (adds `response_inclusion`); bump the
> `WEB_SEARCH` constant in `anthropic.js` to adopt it. `web_fetch_20260318` was
> rejected by this account/endpoint, so `web_fetch_20260209` is used.

**Selected backend endpoints** (all under `/api`, Bearer-authed):

```
auth          /auth/config · /me · /auth/google
profiles      GET/POST /profiles · PATCH/DELETE /profiles/:pid
context       GET/PUT /profiles/:pid/context
details       GET/PUT /profiles/:pid/details
memory        GET /profiles/:pid/memory-files · POST …/stm · POST …/ltm · GET/DELETE …/memory
conversations GET/POST/PATCH/DELETE …/conversations · POST …/conversations/from-cluster
              POST …/conversations/bulk-delete · POST …/auto-tag
messages      POST/PATCH …/conversations/:cid/messages
per-chat AI   POST …/summarize · …/memorize · …/reminder
notes         GET/POST/PATCH/DELETE …/notes
reminders     GET/POST/PATCH/DELETE …/reminders   (with repeat / source / source_ref)
google        POST …/google/auth-url · GET /api/google/callback · GET …/integrations
              POST …/google/sync · POST …/google/import-export · DELETE …/google · GET …/emails
tasks         GET …/tasks · PATCH …/tasks/:name · POST …/tasks/:name/run · POST …/tasks/run-all
import        POST /import/peek · …/import-export · …/import-engine · …/process-batch
lookup        POST /profiles/:pid/lookup          (context + web)
chat          POST /chat                          (NDJSON stream, accepts context[])
maintenance   POST /maintenance/clear-mock · POST /maintenance/sync-bios
```

---

## 21. Privacy, secrets & git hygiene

Local-first by design: all profile data lives under `~/.personal-claude/`, outside
the repo. [`.gitignore`](.gitignore) keeps the following **out of git**:

- **`.env` / `.env.*`** (live API keys, `JWT_SECRET`, Google secret) — only
  `.env.example` templates are committed.
- **`exports/`** — imported ChatGPT / Gemini / Claude personal archives.
- **`bio/`** — per-profile bios, LTM mirrors, and family-relations files.
- `node_modules/`, `dist/`, `*.tsbuildinfo`, `*.db`/`*.sqlite`, logs, OS junk.

No secrets are hardcoded in source. Google **refresh tokens** (for Gmail/Calendar)
are stored **AES-256-GCM-encrypted** in the per-profile DB (under
`~/.personal-claude/`), and Google data access is **read-only**. Rotate any key
that has been shared outside the local `.env`.

---

> **Platform note:** the original spec was a Python terminal CLI. It was adapted to
> this web app — slash-commands in the composer, status in the chat header, tool
> activity as inline lines, and the "memory.py" handler implemented as
> [`backend/src/memory.js`](backend/src/memory.js).
</content>
