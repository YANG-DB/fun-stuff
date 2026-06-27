// Core domain types for Personal Claude.
// These mirror the per-profile data model in idea.md (§5) and are shared by the
// mock data layer and the real backend gateway client.

export type ModelId =
  | "claude-opus-4-8"
  | "claude-sonnet-4-6"
  | "gemini-2.5-pro"
  | "gemini-2.5-flash";

export interface ModelOption {
  id: ModelId;
  label: string;
  provider: "anthropic" | "google";
}

export const MODELS: ModelOption[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google" },
];

/** A linked Google identity (Sign in with Google). Identity only — no scopes. */
export interface GoogleIdentity {
  /** Stable Google account id (the JWT `sub`). */
  sub: string;
  email: string;
  name: string;
  picture: string;
  connectedAt: number;
}

export interface Profile {
  id: string;
  name: string;
  /** Short role/identity line shown under the name. */
  tagline: string;
  /** Persona / system prompt injected per request. */
  persona: string;
  /** Avatar emoji or initials. */
  avatar: string;
  /** Accent color (hex) for this profile's UI. */
  color: string;
  defaultModel: ModelId;
  /** Per-profile monthly spend budget in USD (enforced by the gateway). */
  budgetUsd: number;
  spentUsd: number;
  /** Linked Google account, if the owner connected one. */
  google?: GoogleIdentity;
  /** Number of conversations (supplied by the backend for the profile gate). */
  chatCount?: number;
  /** Total tokens used across all of this profile's sessions. */
  tokens?: number;
  /** Emails allowed to open this profile. Empty = open to any signed-in user. */
  allowedEmails?: string[];
  /** Per-profile chat settings (thinking, effort, tools). */
  settings?: ProfileSettings;
}

export interface ProfileSettings {
  thinking: boolean;
  effort: "low" | "medium" | "high" | "xhigh";
  webTools: boolean;
  memory: boolean;
}

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: Role;
  content: string;
  ts: number;
  model?: ModelId;
  /** Context chips that fed this turn (auto-enrichment, §14 of idea.md). */
  contextUsed?: ContextChip[];
  /** Token usage recorded for this turn (assistant messages). */
  inputTokens?: number;
  outputTokens?: number;
}

/** A retrieved snippet from the profile's own past sessions. */
export interface ContextChip {
  id: string;
  /** Source record id (conversation / note / memory). */
  sourceSessionId: string;
  /** What kind of source this chip points at. */
  kind: "conversation" | "note" | "memory";
  sourceTitle: string;
  reason: string;
  /** Short preview of the matched item (summary/snippet). */
  snippet?: string;
  /** Whether the user has added this chip into the prompt (vs. just suggested). */
  kept: boolean;
}

export interface Conversation {
  id: string;
  profileId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: ModelId;
  messages: Message[];
  /** Concepts extracted for the knowledge graph (later phase; shown as tags). */
  concepts: string[];
  pinned?: boolean;
  /** AI-generated summary + short subject, persisted on summarize/memorize. */
  summary?: string;
  subject?: string;
  /** Originating engine for imported chats: claude | chatgpt | gemini. */
  source?: string;
  /** Soft-deleted: hidden from the UI but recoverable. */
  deleted?: boolean;
  /** Total tokens used across this session (input + output). */
  tokens?: number;
}

export interface Note {
  id: string;
  profileId: string;
  /** Optional link back to the conversation this note came from. */
  conversationId?: string;
  title: string;
  /** Markdown body. */
  body: string;
  createdAt: number;
  updatedAt: number;
}

export type Repeat = "none" | "daily" | "weekly" | "monthly" | "yearly";

export interface Reminder {
  id: string;
  profileId: string;
  text: string;
  dueAt: number;
  done: boolean;
  /** Recurrence: rolls the due date forward when completed. */
  repeat?: Repeat;
  /** Provenance: manual | gcal (calendar event) | gmail (email task). */
  source?: "manual" | "gcal" | "gmail";
  conversationId?: string;
}

/** An entry in the profile's running memory (a remembered conversation summary). */
export interface MemoryEntry {
  id: string;
  profileId: string;
  conversationId?: string;
  subject: string;
  body: string;
  createdAt: number;
}
