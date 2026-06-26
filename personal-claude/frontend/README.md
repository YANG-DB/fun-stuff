# Personal Claude — Frontend

The thin web client for **Personal Claude** (see [`../idea.md`](../idea.md)). Phase-1
MVP scope: multi-profile chat through a shared gateway, with per-profile
conversations, notes, and reminders.

## Stack

- **Vite + React + TypeScript**
- `lucide-react` icons, `marked` for markdown
- Client state in `src/store.tsx`, persisted to `localStorage`
- Gateway-ready chat client in `src/services/chatService.ts`

## Run

The app now expects the **backend** (SQLite persistence + chat gateway). Start
both, in two terminals:

```bash
# 1) backend  → http://localhost:8787  (owns the per-profile SQLite files)
cd ../backend && npm install && npm run dev

# 2) frontend → http://localhost:3000  (proxies /api to the backend)
npm install && npm run dev
```

Data persists in `~/.personal-claude/` (file-per-profile). If the backend is
down, the app shows a clear "can't reach the backend" screen; chat alone falls
back to a local mock.

## Connect a Google account (Sign in with Google)

Each profile can link a Google identity (name, email, avatar) via the **gear
icon → Profile settings**. Identity only — no Drive/Gmail/Calendar scopes.

- **Demo mode (default):** with no Client ID set, "Continue with Google"
  fabricates a believable identity so the flow is exercisable locally.
- **Real sign-in:** create an OAuth 2.0 **Web application** Client ID in Google
  Cloud Console, add `http://localhost:3000` as an Authorized JavaScript origin,
  then set `VITE_GOOGLE_CLIENT_ID` in `.env.local` (see `.env.example`). No
  client secret or backend needed — it's the client-side GIS flow.

## Wiring the real gateway (later)

The UI is built to swap to the real backend with no component changes:

1. Stand up the **app server + LiteLLM proxy** (holds the single shared key,
   meters spend per profile) exposing `POST /api/chat` (SSE/stream).
2. Run the frontend with `VITE_USE_BACKEND=1` — `chatService` then streams from
   `/api/chat` instead of the mock. `vite.config.ts` proxies `/api` to
   `http://localhost:8787`.
3. Replace the seed data / `localStorage` store with calls to the per-profile
   backend tables (Postgres + pgvector).

## What's implemented

- **Profile gate** — pick a profile (convenience switch, not crypto isolation)
- **Sidebar** — per-profile budget meter, tabbed **Chats / Notes / Reminders**,
  chat search, pinning, concept tags
- **Chat view** — model selector (Claude + Gemini), streaming replies, markdown,
  "save as note", and **transparent context chips** (auto-enrichment preview you
  can veto per message)

## Not yet (later phases)

headroom compression, real semantic search, embeddings, the knowledge graph, and
the synthesized-answer search mode — see `../idea.md` roadmap (§8).
