// LinkedIn manager — local multi-agent reply pipeline + content templates.
//
// Adapted from the "LinkedIn Monitor — Local Multi-Agent Architecture" design:
//   Receiver → Analyzer → Composer → Validator → Auditor → (manual gate) → Dispatcher
// The agents here are model-agnostic: each takes a `runModel(model, system, msgs)`
// function (Claude / Gemini / a local gateway) so the provider is swappable.
// Browser automation (Selenium/CDP scraping + posting) stays OUTSIDE this process:
// the Receiver is fed via an ingest endpoint, and an approved draft is surfaced
// for manual paste (or an optional local dispatcher webhook). No LinkedIn API.

import { EventEmitter } from "node:events";

/** The "Agent Bus" — every stage emits here (telemetry / observability seam). */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

function firstJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : JSON.parse(text);
}

// --- Built-in templates ("templates and resources") -------------------------

/** Outbound post structures Claude fills in for the profile's voice. */
export const POST_TEMPLATES = [
  { id: "thought-leadership", kind: "post", name: "Thought leadership",
    structure: "Hook (1 bold line) → a contrarian or non-obvious insight → 3 concise supporting points → the lesson → an open question to the reader." },
  { id: "story", kind: "post", name: "Personal story",
    structure: "Set the scene → the turning point / struggle → what you did → the outcome → the transferable takeaway." },
  { id: "announcement", kind: "post", name: "Announcement",
    structure: "What's new (1 line) → why it matters → key details / link → credit the team → a clear call to action." },
  { id: "how-to", kind: "post", name: "How-to / listicle",
    structure: "Promise of value → numbered, skimmable steps or tips → one example each → wrap-up takeaway → invite saves/shares." },
  { id: "hiring", kind: "post", name: "Hiring",
    structure: "Role + team in one line → what they'll work on → who thrives here → why your company → how to apply." },
  { id: "poll", kind: "post", name: "Poll prompt",
    structure: "Frame a sharp either/or question → why it's interesting → 2-4 short options → invite reasons in comments." },
];

/** Reply tones for the Composer when answering an inbound message. */
export const REPLY_TONES = [
  { id: "professional", name: "Professional", note: "warm but businesslike, concise" },
  { id: "friendly", name: "Friendly", note: "personable, first-name, light" },
  { id: "concise", name: "Concise", note: "2-3 sentences max, get to the point" },
  { id: "enthusiastic", name: "Enthusiastic", note: "high energy, appreciative" },
];

/** Outreach / comment templates Claude personalizes (sent manually). */
export const OUTREACH_TEMPLATES = [
  { id: "connection-note", kind: "outreach", name: "Connection note",
    structure: "Why connecting now (shared context) → one specific, genuine reason → no ask → < 280 chars." },
  { id: "cold-intro", kind: "outreach", name: "Cold intro",
    structure: "Relevant hook about them → one line on who you are → a small, specific ask → easy out." },
  { id: "congrats", kind: "outreach", name: "Congrats / milestone",
    structure: "Name the milestone specifically → why it's impressive → a forward-looking line." },
  { id: "comment-value", kind: "comment", name: "Value-add comment",
    structure: "Affirm one point → add a fresh angle or example → a short question to continue the thread." },
  { id: "follow-up", kind: "outreach", name: "Follow-up",
    structure: "Reference the prior touchpoint → restate value in one line → propose a concrete next step." },
];

export function allBuiltins() {
  return [...POST_TEMPLATES, ...OUTREACH_TEMPLATES];
}

// --- Agent stages -----------------------------------------------------------

/** Analyzer — intent / priority / urgency / sentiment of an inbound message. */
export async function analyze(runModel, model, message) {
  const raw = await runModel(
    model,
    "You triage inbound LinkedIn messages. Respond ONLY with JSON (no prose, no code fences): " +
      '{"intent":"<one of: networking|job-inquiry|recruiting|sales-pitch|question|collaboration|congratulation|introduction|spam|other>",' +
      '"priority":"<high|medium|low>","urgency":"<high|medium|low>","sentiment":"<positive|neutral|negative>",' +
      '"summary":"<one short line on what they want>"}',
    [{ role: "user", content: `From: ${message.sender || "unknown"}${message.headline ? ` (${message.headline})` : ""}\n\nMessage:\n${message.text}` }],
  );
  let p;
  try { p = firstJson(raw); } catch { p = {}; }
  const pick = (v, set, d) => (set.includes(String(v)) ? String(v) : d);
  const out = {
    intent: pick(p.intent, ["networking", "job-inquiry", "recruiting", "sales-pitch", "question", "collaboration", "congratulation", "introduction", "spam", "other"], "other"),
    priority: pick(p.priority, ["high", "medium", "low"], "medium"),
    urgency: pick(p.urgency, ["high", "medium", "low"], "low"),
    sentiment: pick(p.sentiment, ["positive", "neutral", "negative"], "neutral"),
    summary: String(p.summary || "").slice(0, 160),
  };
  bus.emit("message.analyzed", { id: message.id, ...out });
  return out;
}

/** Composer — draft a reply in the profile's voice using a tone + analysis. */
export async function compose(runModel, model, message, opts = {}) {
  const { persona = "", tone = "professional", analysis = {}, voiceNotes = "" } = opts;
  const toneNote = REPLY_TONES.find((t) => t.id === tone)?.note || "professional, concise";
  const system =
    "You draft a LinkedIn DM reply on behalf of the user. Write only the reply text — no quotes, no preamble, " +
    "no subject line, no signature block. Keep it natural, specific to their message, and easy to send as-is. " +
    `Tone: ${toneNote}. Aim for 2-5 sentences. ` +
    (persona ? `\n\nThe user (write as them):\n${persona}` : "") +
    (voiceNotes ? `\n\nVoice/context notes:\n${voiceNotes}` : "");
  const body = (await runModel(model, system, [
    { role: "user", content:
      `Their message (from ${message.sender || "a connection"}):\n${message.text}\n\n` +
      (analysis.intent ? `Detected intent: ${analysis.intent}; sentiment: ${analysis.sentiment}.\n\n` : "") +
      "Write the reply." },
  ])).trim();
  bus.emit("message.composed", { id: message.id, body });
  return body;
}

/** Validator — relevance / completeness / tone check of a draft (0-100). */
export async function validate(runModel, model, message, body) {
  const raw = await runModel(
    model,
    "You review a draft LinkedIn reply against the message it answers. Respond ONLY with JSON: " +
      '{"relevance":<0-100>,"completeness":<0-100>,"tone":<0-100>,"issues":"<one short line, or empty>"}',
    [{ role: "user", content: `Their message:\n${message.text}\n\nDraft reply:\n${body}\n\nScore it.` }],
  );
  let p;
  try { p = firstJson(raw); } catch { p = {}; }
  const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
  const out = {
    relevance: clamp(p.relevance),
    completeness: clamp(p.completeness),
    tone_ok: clamp(p.tone),
    issues: String(p.issues || "").slice(0, 160),
  };
  bus.emit("message.validated", { id: message.id, ...out });
  return out;
}

/** Auditor — quality score + recommendation (heuristics over validator output). */
export function audit(validation, body, analysis = {}) {
  const { relevance = 0, completeness = 0, tone_ok = 0 } = validation || {};
  const len = (body || "").trim().length;
  // Penalize empty / over-long drafts; reward balanced scores.
  let score = Math.round(relevance * 0.45 + completeness * 0.3 + tone_ok * 0.25);
  if (len < 20) score = Math.min(score, 40);
  if (len > 900) score -= 10;
  score = Math.max(0, Math.min(100, score));
  // Spam shouldn't be auto-recommended for sending, however polished the reply.
  if (analysis.intent === "spam") {
    const out = { quality_score: Math.min(score, 30), recommendation: "skip" };
    bus.emit("message.ready_for_review", out);
    return out;
  }
  const recommendation = score >= 75 ? "approve" : score >= 55 ? "review" : "revise";
  const out = { quality_score: score, recommendation };
  bus.emit("message.ready_for_review", out);
  return out;
}
