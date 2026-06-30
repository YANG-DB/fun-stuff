import type {
  Conversation,
  Message,
  Note,
  Profile,
  Reminder,
  MemoryEntry,
} from "../types";
import { getToken, clearToken } from "./session";

// Typed client for the backend gateway. All calls go through /api, which Vite
// proxies to the Node server (which owns the per-profile SQLite files).

export class UnauthorizedError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new UnauthorizedError("session expired");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`API ${res.status} ${path}: ${detail.slice(0, 120)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

export interface ProfileDetails {
  name?: string;
  location?: string;
  role?: string;
  bio?: string;
  websites?: string[];
  socials?: { label: string; url: string }[];
  custom?: { label: string; value: string }[];
}

export interface LiTemplate {
  id: string;
  kind: string;
  name: string;
  structure: string;
  custom?: boolean;
}
export interface LiDraft {
  id: string;
  messageId: string;
  body: string;
  template?: string | null;
  tone?: string | null;
  relevance?: number;
  completeness?: number;
  toneOk?: number;
  qualityScore?: number;
  recommendation?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}
export interface LiMessage {
  id: string;
  ts: number;
  sender?: string;
  headline?: string;
  text: string;
  threadUrl?: string;
  intent?: string;
  priority?: string;
  urgency?: string;
  sentiment?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  draft?: LiDraft | null;
}
export interface LiPost {
  id: string;
  kind: string;
  template?: string | null;
  topic?: string | null;
  title?: string | null;
  body: string;
  hashtags: string[];
  status: string;
  scheduledAt?: number | null;
  createdAt: number;
  updatedAt: number;
  postedAt?: number | null;
}

export const api = {
  // auth
  authConfig: () => req<{ authRequired: boolean }>("/auth/config"),
  me: () => req<{ user: AuthUser | null; authRequired: boolean }>("/me"),
  loginGoogle: (credential: string) =>
    req<{ token: string; user: AuthUser }>("/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential }),
    }),

  // profiles
  listProfiles: () => req<Profile[]>("/profiles"),
  createProfile: (data: Partial<Profile>) =>
    req<Profile>("/profiles", { method: "POST", body: JSON.stringify(data) }),
  updateProfile: (id: string, patch: Partial<Profile>) =>
    req<Profile>(`/profiles/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteProfile: (id: string) =>
    req(`/profiles/${id}`, { method: "DELETE" }),

  // Google Workspace (Gmail + Calendar) per-profile integration
  googleStatus: (pid: string) =>
    req<{ configured: boolean; google: { connected: boolean; email?: string | null; lastSync?: number | null; scope?: string } }>(
      `/profiles/${pid}/integrations`,
    ),
  googleAuthUrl: (pid: string) =>
    req<{ url: string }>(`/profiles/${pid}/google/auth-url`, { method: "POST" }),
  googleSync: (pid: string) =>
    req<{ ok: boolean; calendar: number; gmail: number; digest: string }>(`/profiles/${pid}/google/sync`, {
      method: "POST",
    }),
  googleDisconnect: (pid: string) =>
    req(`/profiles/${pid}/google`, { method: "DELETE" }),
  // stored emails (from sync / offline import)
  listEmails: (pid: string) =>
    req<{ emails: { id: string; ts: number; from: string; subject: string; snippet: string; source: string }[] }>(
      `/profiles/${pid}/emails`,
    ),
  // offline test: import a Google Takeout folder (.ics + .mbox), no API connection
  googleImportExport: (pid: string, dir: string, days?: number) =>
    req<{ ok: boolean; calendar: number; gmail: number; digest: string; parsedEvents: number; parsedEmails: number; windowDays: number; windowedEvents: number; windowedEmails: number }>(
      `/profiles/${pid}/google/import-export`,
      { method: "POST", body: JSON.stringify({ dir, days }) },
    ),

  // scheduled daily tasks (sync, memory refresh, briefing…)
  listTasks: (pid: string) =>
    req<{ tasks: { name: string; label: string; enabled: boolean; lastRun: number | null; lastResult: string | null }[] }>(
      `/profiles/${pid}/tasks`,
    ),
  setTask: (pid: string, name: string, enabled: boolean) =>
    req(`/profiles/${pid}/tasks/${name}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  runTask: (pid: string, name: string) =>
    req<{ ok: boolean; name: string; result: string; lastRun: number }>(`/profiles/${pid}/tasks/${name}/run`, {
      method: "POST",
    }),
  runAllTasks: (pid: string) =>
    req<{ ok: boolean; ran: { name: string; result: string }[] }>(`/profiles/${pid}/tasks/run-all`, { method: "POST" }),

  // look up a word/phrase across this profile's context + the web
  lookup: (pid: string, q: string) =>
    req<{
      q: string;
      local: { type: string; id: string; conversationId?: string; title: string; snippet: string }[];
      web: { summary: string; sources: { url: string; title: string }[]; error?: string };
    }>(`/profiles/${pid}/lookup`, { method: "POST", body: JSON.stringify({ q }) }),

  // per-profile structured personal details (woven into the LTM file)
  getDetails: (pid: string) => req<ProfileDetails>(`/profiles/${pid}/details`),
  putDetails: (pid: string, details: ProfileDetails) =>
    req<{ details: ProfileDetails; ltm: string }>(`/profiles/${pid}/details`, {
      method: "PUT",
      body: JSON.stringify(details),
    }),

  // per-profile curated user_context.md
  getContext: (pid: string) => req<{ content: string }>(`/profiles/${pid}/context`),
  putContext: (pid: string, content: string) =>
    req(`/profiles/${pid}/context`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  // generate showcase/mock conversations for the Explore views
  generateMock: (pid: string) =>
    req<{ imported: number }>(`/profiles/${pid}/mock`, { method: "POST" }),

  // list conversations in an on-disk export without importing (for assignment)
  peekExport: (dir: string) =>
    req<{ items: { uuid: string; name: string; summary: string; messages: number; createdAt: number }[] }>(
      "/import/peek",
      { method: "POST", body: JSON.stringify({ dir }) },
    ),
  // import a Claude export from disk (optionally a subset of ids) + auto-summaries
  importExport: (pid: string, dir: string, ids?: string[]) =>
    req<{
      imported: number;
      skipped: number;
      messages: number;
      ids: string[];
      items: { id: string; title: string }[];
    }>(`/profiles/${pid}/import-export`, {
      method: "POST",
      body: JSON.stringify({ dir, ids }),
    }),
  // LLM triage of imported conversations (topics + reminder-if-needed + memory-worthy)
  processBatch: (pid: string, ids: string[]) =>
    req<{
      processed: number;
      reminders: number;
      memorized: number;
      results: { id: string; topics: number; reminder: boolean; memorized: boolean }[];
    }>(`/profiles/${pid}/process-batch`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),

  // import a Claude.ai export (conversations.json) to bootstrap history
  importClaude: (pid: string, data: unknown) =>
    req<{ imported: number; skipped: number; messages: number }>(
      `/profiles/${pid}/import`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  // conversations
  listConversations: (pid: string) =>
    req<Conversation[]>(`/profiles/${pid}/conversations`),
  createConversation: (pid: string, model: string) =>
    req<Conversation>(`/profiles/${pid}/conversations`, {
      method: "POST",
      body: JSON.stringify({ model }),
    }),
  patchConversation: (
    pid: string,
    cid: string,
    patch: { title?: string; pinned?: boolean; model?: string; deleted?: boolean; concepts?: string[] },
  ) =>
    req(`/profiles/${pid}/conversations/${cid}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // auto-tag short one-off question conversations with a concept tag
  autoTagQuick: (pid: string, tag?: string) =>
    req<{ ok: boolean; tag: string; tagged: number }>(`/profiles/${pid}/auto-tag`, {
      method: "POST",
      body: JSON.stringify({ tag }),
    }),
  deleteConversation: (pid: string, cid: string) =>
    req(`/profiles/${pid}/conversations/${cid}`, { method: "DELETE" }),
  // soft-delete / restore many conversations at once
  bulkSetDeleted: (pid: string, ids: string[], deleted: boolean) =>
    req<{ ok: boolean; updated: number; deleted: boolean }>(
      `/profiles/${pid}/conversations/bulk-delete`,
      { method: "POST", body: JSON.stringify({ ids, deleted }) },
    ),
  // import a ChatGPT or Gemini export folder, tagged with its source engine
  importEngine: (pid: string, engine: "chatgpt" | "gemini", dir: string, ids?: string[]) =>
    req<{ imported: number; skipped: number; messages: number; ids: string[]; items: { id: string; title: string }[] }>(
      `/profiles/${pid}/import-engine`,
      { method: "POST", body: JSON.stringify({ engine, dir, ids }) },
    ),
  // soft-delete all generated mock chats across every profile
  clearMock: () =>
    req<{ ok: boolean; cleared: { profile: string; marked: number }[] }>("/maintenance/clear-mock", {
      method: "POST",
    }),
  // new conversation seeded from arbitrary content (an email / calendar event)
  seedConversation: (pid: string, title: string, body: string) =>
    req<Conversation>(`/profiles/${pid}/conversations/seed`, {
      method: "POST",
      body: JSON.stringify({ title, body }),
    }),
  // new session seeded from a cluster of related conversations (continuity briefing)
  continueCluster: (pid: string, ids: string[], title?: string) =>
    req<Conversation>(`/profiles/${pid}/conversations/from-cluster`, {
      method: "POST",
      body: JSON.stringify({ ids, title }),
    }),

  // messages
  addMessage: (pid: string, cid: string, msg: Message) =>
    req<{ id: string }>(`/profiles/${pid}/conversations/${cid}/messages`, {
      method: "POST",
      body: JSON.stringify(msg),
    }),
  patchMessage: (pid: string, cid: string, mid: string, content: string) =>
    req(`/profiles/${pid}/conversations/${cid}/messages/${mid}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),

  // per-chat AI actions
  summarizeChat: (pid: string, cid: string) =>
    req<{ subject: string; summary: string; topics: string[] }>(
      `/profiles/${pid}/conversations/${cid}/summarize`,
      { method: "POST" },
    ),
  reminderFromChat: (pid: string, cid: string) =>
    req<{ text: string; dueInDays: number }>(
      `/profiles/${pid}/conversations/${cid}/reminder`,
      { method: "POST" },
    ),
  memorizeChat: (pid: string, cid: string) =>
    req<{ id: string; subject: string; summary: string; topics: string[] }>(
      `/profiles/${pid}/conversations/${cid}/memorize`,
      { method: "POST" },
    ),
  listMemory: (pid: string) => req<MemoryEntry[]>(`/profiles/${pid}/memory`),
  deleteMemory: (pid: string, mid: string) =>
    req(`/profiles/${pid}/memory/${mid}`, { method: "DELETE" }),

  // layered memory files (STM / LTM)
  getMemoryFiles: (pid: string) =>
    req<{ stm: string; stmUpdated: number; ltm: string; ltmUpdated: number }>(
      `/profiles/${pid}/memory-files`,
    ),
  refreshStm: (pid: string) =>
    req<{ content: string; updatedAt: number }>(`/profiles/${pid}/stm`, {
      method: "POST",
    }),
  refreshLtm: (pid: string) =>
    req<{ content: string; updatedAt: number }>(`/profiles/${pid}/ltm`, {
      method: "POST",
    }),
  // family-relations markdown (bio/<slug>_family.md) — for the summary page
  getFamily: (pid: string) =>
    req<{ family: string; updatedAt: number }>(`/profiles/${pid}/family`),

  // ---- LinkedIn manager --------------------------------------------------
  liTemplates: (pid: string) =>
    req<{
      post: LiTemplate[];
      outreach: LiTemplate[];
      tones: { id: string; name: string; note: string }[];
      custom: LiTemplate[];
    }>(`/profiles/${pid}/linkedin/templates`),
  liAddTemplate: (pid: string, t: { kind: string; name: string; structure: string }) =>
    req<LiTemplate>(`/profiles/${pid}/linkedin/templates`, { method: "POST", body: JSON.stringify(t) }),
  liDeleteTemplate: (pid: string, id: string) =>
    req(`/profiles/${pid}/linkedin/templates/${id}`, { method: "DELETE" }),

  liMessages: (pid: string) =>
    req<{ messages: LiMessage[] }>(`/profiles/${pid}/linkedin/messages`),
  liIngest: (pid: string, m: { sender?: string; headline?: string; text: string; threadUrl?: string; autoProcess?: boolean }) =>
    req<{ ok: boolean; message: LiMessage }>(`/profiles/${pid}/linkedin/messages`, { method: "POST", body: JSON.stringify(m) }),
  liProcess: (pid: string, id: string, opts?: { tone?: string }) =>
    req<{ message: LiMessage }>(`/profiles/${pid}/linkedin/messages/${id}/process`, { method: "POST", body: JSON.stringify(opts || {}) }),
  liDeleteMessage: (pid: string, id: string) =>
    req(`/profiles/${pid}/linkedin/messages/${id}`, { method: "DELETE" }),
  liSeedDemo: (pid: string) =>
    req<{ ok: boolean; added: number }>(`/profiles/${pid}/linkedin/seed-demo`, { method: "POST" }),

  liEditDraft: (pid: string, id: string, patch: { body?: string; status?: string }) =>
    req<LiDraft>(`/profiles/${pid}/linkedin/drafts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  liRedraft: (pid: string, id: string, tone?: string) =>
    req<LiDraft>(`/profiles/${pid}/linkedin/drafts/${id}/redraft`, { method: "POST", body: JSON.stringify({ tone }) }),
  liApprove: (pid: string, id: string) =>
    req<{ ok: boolean; reply: string; dispatched: boolean }>(`/profiles/${pid}/linkedin/drafts/${id}/approve`, { method: "POST" }),
  liReject: (pid: string, id: string) =>
    req<{ ok: boolean }>(`/profiles/${pid}/linkedin/drafts/${id}/reject`, { method: "POST" }),

  liPosts: (pid: string) => req<{ posts: LiPost[] }>(`/profiles/${pid}/linkedin/posts`),
  liAddPost: (pid: string, p: Partial<LiPost>) =>
    req<LiPost>(`/profiles/${pid}/linkedin/posts`, { method: "POST", body: JSON.stringify(p) }),
  liUpdatePost: (pid: string, id: string, patch: Partial<LiPost>) =>
    req<LiPost>(`/profiles/${pid}/linkedin/posts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  liDeletePost: (pid: string, id: string) =>
    req(`/profiles/${pid}/linkedin/posts/${id}`, { method: "DELETE" }),
  liDraftPost: (pid: string, body: { template?: string; topic?: string; kind?: string }) =>
    req<{ title: string; body: string; hashtags: string[] }>(`/profiles/${pid}/linkedin/posts/draft`, { method: "POST", body: JSON.stringify(body) }),

  // notes
  listNotes: (pid: string) => req<Note[]>(`/profiles/${pid}/notes`),
  addNote: (pid: string, note: Partial<Note>) =>
    req<Note>(`/profiles/${pid}/notes`, {
      method: "POST",
      body: JSON.stringify(note),
    }),
  patchNote: (pid: string, nid: string, patch: Partial<Note>) =>
    req(`/profiles/${pid}/notes/${nid}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteNote: (pid: string, nid: string) =>
    req(`/profiles/${pid}/notes/${nid}`, { method: "DELETE" }),

  // reminders
  listReminders: (pid: string) => req<Reminder[]>(`/profiles/${pid}/reminders`),
  addReminder: (pid: string, r: Partial<Reminder>) =>
    req<Reminder>(`/profiles/${pid}/reminders`, {
      method: "POST",
      body: JSON.stringify(r),
    }),
  patchReminder: (
    pid: string,
    rid: string,
    patch: { done?: boolean; dueAt?: number; text?: string; repeat?: string },
  ) =>
    req(`/profiles/${pid}/reminders/${rid}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteReminder: (pid: string, rid: string) =>
    req(`/profiles/${pid}/reminders/${rid}`, { method: "DELETE" }),
};
