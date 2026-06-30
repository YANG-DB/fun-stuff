import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar as CalIcon,
  CalendarRange,
  Network,
  Flame,
  ChevronLeft,
  ChevronRight,
  Database,
  X,
  ArrowRight,
  ArrowLeft,
  Maximize2,
  Shuffle,
  MessageSquarePlus,
  Loader,
  ZoomIn,
  Workflow,
  MessageSquare,
  FileText,
  Tag,
  Clock,
  Brain,
  Check,
  Plus,
  Mail,
  Bell,
  Search,
  User,
  Users,
  Sparkles,
  History,
  CalendarClock,
  Star,
  Pin,
  MapPin,
  Briefcase,
  Link as LinkIcon,
  Linkedin,
  Inbox,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  Copy,
  Send,
  Trash2,
  Wand2,
} from "lucide-react";
import { useStore } from "../store";
import { api } from "../services/api";
import type { ProfileDetails, LiMessage, LiPost, LiTemplate } from "../services/api";
import { streamChat } from "../services/chatService";
import { forceLayout, relTime, occurrencesInRange, md } from "../utils";
import type { Conversation, Repeat, Message, Profile, ModelId } from "../types";
import { ImportArchive } from "./ImportArchive";

function cleanSnippet(s: string, n = 150): string {
  return s.replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
}

export type ExploreTab = "summary" | "calendar" | "weekly" | "graph" | "topics" | "pipeline" | "emails" | "linkedin";

const PALETTE = [
  "#D97757", "#7C6FF0", "#3BA776", "#E0903C",
  "#4A9DD8", "#C2548A", "#6BBF59", "#B5683C",
];
function colorFor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// distinct hues for clusters (more than the base PALETTE so neighbours differ)
const CLUSTER_HUES = [16, 256, 150, 32, 205, 320, 105, 25, 285, 180, 50, 0];
function clusterColor(i: number): string {
  return `hsl(${CLUSTER_HUES[i % CLUSTER_HUES.length]} 62% 55%)`;
}

// Community detection via weighted label propagation. Returns nodeId -> compact
// cluster index. Linked nodes converge to a shared label → "show in cluster".
function clusterize(ids: string[], edges: { a: string; b: string; w: number }[]): Map<string, number> {
  const adj: Record<string, { n: string; w: number }[]> = {};
  for (const id of ids) adj[id] = [];
  for (const e of edges) {
    if (adj[e.a]) adj[e.a].push({ n: e.b, w: e.w });
    if (adj[e.b]) adj[e.b].push({ n: e.a, w: e.w });
  }
  const label = new Map<string, number>(ids.map((id, i) => [id, i]));
  for (let iter = 0; iter < 14; iter++) {
    let changed = false;
    for (const id of ids) {
      const ns = adj[id];
      if (!ns.length) continue;
      const counts = new Map<number, number>();
      for (const { n, w } of ns) {
        const l = label.get(n)!;
        counts.set(l, (counts.get(l) || 0) + w);
      }
      let best = label.get(id)!;
      let bestW = -1;
      for (const [l, w] of counts) {
        if (w > bestW || (w === bestW && l < best)) {
          bestW = w;
          best = l;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // compact labels to 0..k, ordered by descending cluster size for stable colours
  const size = new Map<number, number>();
  for (const l of label.values()) size.set(l, (size.get(l) || 0) + 1);
  const order = [...size.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const remap = new Map<number, number>(order.map((l, i) => [l, i]));
  const out = new Map<string, number>();
  for (const [id, l] of label) out.set(id, remap.get(l)!);
  return out;
}

const DAY = 86_400_000;
const sod = (ts: number) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const sow = (ts: number) => {
  const d = new Date(ts);
  const dow = (d.getDay() + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dow);
  return d.getTime();
};

export function Explore({
  onOpenChat,
  tab,
  onTabChange,
  pipelineConvId,
  onPipelineSelect,
}: {
  onOpenChat: (id: string) => void;
  tab: ExploreTab;
  onTabChange: (t: ExploreTab) => void;
  pipelineConvId?: string | null;
  onPipelineSelect?: (id: string) => void;
}) {
  const { conversations: allConversations, loadMock } = useStore();
  // Soft-deleted and empty (no-message) chats never appear in the visualizations.
  const conversations = useMemo(
    () => allConversations.filter((c) => !c.deleted && c.messages.length > 0),
    [allConversations],
  );
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  async function showcase() {
    setLoading(true);
    try {
      await loadMock();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="explore">
      <header className="explore-head">
        <nav className="explore-tabs">
          <TabBtn on={tab === "summary"} onClick={() => onTabChange("summary")} icon={<User size={15} />} label="Summary" />
          <TabBtn on={tab === "calendar"} onClick={() => onTabChange("calendar")} icon={<CalIcon size={15} />} label="Calendar" />
          <TabBtn on={tab === "weekly"} onClick={() => onTabChange("weekly")} icon={<CalendarRange size={15} />} label="This week" />
          <TabBtn on={tab === "graph"} onClick={() => onTabChange("graph")} icon={<Network size={15} />} label="Knowledge graph" />
          <TabBtn on={tab === "topics"} onClick={() => onTabChange("topics")} icon={<Flame size={15} />} label="Topics" />
          <TabBtn on={tab === "pipeline"} onClick={() => onTabChange("pipeline")} icon={<Workflow size={15} />} label="Pipeline" />
          <TabBtn on={tab === "emails"} onClick={() => onTabChange("emails")} icon={<Mail size={15} />} label="Emails" />
          <TabBtn on={tab === "linkedin"} onClick={() => onTabChange("linkedin")} icon={<Linkedin size={15} />} label="LinkedIn" />
        </nav>
        <div className="explore-head-actions">
          <button className="btn-secondary" onClick={() => setImporting(true)}>
            <Database size={14} /> Import archive
          </button>
          <button className="btn-secondary" disabled={loading} onClick={showcase}>
            <Database size={14} /> {loading ? "Loading…" : "Showcase data"}
          </button>
        </div>
      </header>
      {importing && <ImportArchive onClose={() => setImporting(false)} />}

      <div className="explore-body">
        {tab === "pipeline" ? (
          <PipelineFlow
            chats={conversations}
            onOpen={onOpenChat}
            onTabChange={onTabChange}
            selectedId={pipelineConvId}
            onSelectId={onPipelineSelect}
          />
        ) : tab === "emails" ? (
          <EmailsView onOpen={onOpenChat} />
        ) : tab === "summary" ? (
          <SummaryView chats={conversations} onOpen={onOpenChat} onTabChange={onTabChange} />
        ) : tab === "linkedin" ? (
          <LinkedInView />
        ) : conversations.length === 0 ? (
          <div className="explore-empty">
            <div className="boot-mark">◆</div>
            <h2>Nothing to explore yet</h2>
            <p>
              Start chatting, or load a set of showcase conversations to see the
              calendar, weekly, knowledge-graph and topic views in action.
            </p>
            <button className="new-chat-btn" disabled={loading} onClick={showcase}>
              <Database size={16} /> {loading ? "Loading…" : "Load showcase data"}
            </button>
          </div>
        ) : tab === "calendar" ? (
          <CalendarView chats={conversations} onOpen={onOpenChat} />
        ) : tab === "weekly" ? (
          <WeeklyView chats={conversations} onOpen={onOpenChat} />
        ) : tab === "graph" ? (
          <ChatGraphView chats={conversations} onOpen={onOpenChat} />
        ) : (
          <TopicGraphView chats={conversations} onOpen={onOpenChat} />
        )}
      </div>
    </main>
  );
}

function TabBtn(props: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button className={`explore-tab ${props.on ? "active" : ""}`} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

// ---- Emails (browse synced/imported mail) ---------------------------------

function EmailsView({ onOpen }: { onOpen: (id: string) => void }) {
  const { activeProfile, reminders, notes, seedConversation, addReminder } = useStore();
  const [emails, setEmails] = useState<{ id: string; ts: number; from: string; subject: string; snippet: string; source: string }[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [tasked, setTasked] = useState<Set<string>>(new Set());
  const [composer, setComposer] = useState<null | { source?: EmailSource }>(null);

  type EV = { id: string; ts: number; from: string; subject: string; snippet: string; source: string };
  const discuss = async (e: EV) => {
    const body = `📧 **${e.subject || "(no subject)"}**\nFrom: ${e.from}${e.ts ? ` · ${new Date(e.ts).toLocaleDateString()}` : ""}\n\n${e.snippet}\n\n_Ask me anything about this email._`;
    const c = await seedConversation((e.subject || "Email").slice(0, 60), body);
    onOpen(c.id);
  };
  const makeTask = (e: EV) => {
    if (!activeProfile) return;
    addReminder({ profileId: activeProfile.id, text: `✉️ ${e.subject || "Email"}`, dueAt: Date.now() + 2 * 86_400_000, done: false, repeat: "none" });
    setTasked((s) => new Set(s).add(e.id));
  };

  useEffect(() => {
    if (!activeProfile) return;
    setLoading(true);
    api.listEmails(activeProfile.id).then((r) => setEmails(r.emails)).catch(() => {}).finally(() => setLoading(false));
  }, [activeProfile?.id]);

  const digest = notes.find((n) => /Inbox digest/.test(n.title))?.body;
  const tasks = reminders.filter((r) => r.source === "gmail").sort((a, b) => Number(a.done) - Number(b.done) || a.dueAt - b.dueAt);
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? emails.filter((e) => `${e.subject} ${e.from} ${e.snippet}`.toLowerCase().includes(ql))
    : emails;

  return (
    <div className="emails-view">
      <div className="ev-bar">
        <div className="sb-search ev-search">
          <Search size={14} />
          <input placeholder="Search email…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="ev-count">{filtered.length} / {emails.length} emails</span>
        <button className="ev-compose-btn" onClick={() => setComposer({})} title="Quick compose / format with AI (disposable)">
          <Wand2 size={14} /> Compose assistant
        </button>
      </div>
      {composer && activeProfile && (
        <EmailComposer
          profile={activeProfile}
          source={composer.source}
          onClose={() => setComposer(null)}
        />
      )}
      <div className="ev-body">
        {digest && (
          <div className="pf-digest"><b>📥 Inbox digest</b><p>{digest}</p></div>
        )}
        {tasks.length > 0 && (
          <>
            <div className="pf-sec-h">Action items <span className="pf-count">{tasks.length}</span></div>
            <ul className="pf-rem-list">
              {tasks.map((r) => (
                <li key={r.id} className={r.done ? "done" : ""}>
                  <span className="pf-rem-text">{r.text}</span>
                  <span className="pf-rem-due">{new Date(r.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="pf-sec-h">Emails <span className="pf-count">{emails.length}</span></div>
        {loading ? (
          <div className="lookup-muted">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="lookup-muted">
            {emails.length === 0
              ? "No emails yet — connect Gmail (⚙ → Gmail & Calendar) or import a Takeout .mbox, then sync."
              : "No emails match your search."}
          </div>
        ) : (
          <ul className="pf-email-list ev-list">
            {filtered.map((e) => (
              <li key={e.id}>
                <div className="pf-email-top">
                  <span className="pf-email-subj">{e.subject || "(no subject)"}</span>
                  <span className="pf-rem-due">{e.ts ? new Date(e.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span>
                </div>
                {e.from && <div className="pf-email-from">{e.from}</div>}
                {e.snippet && <div className="pf-email-snip">{e.snippet}</div>}
                <div className="ev-actions">
                  <button onClick={() => setComposer({ source: { from: e.from, subject: e.subject, snippet: e.snippet, ts: e.ts } })} title="Draft a reply with AI (disposable)">
                    <Wand2 size={13} /> Reply
                  </button>
                  <button onClick={() => discuss(e)} title="Open a conversation about this email">
                    <MessageSquarePlus size={13} /> Discuss
                  </button>
                  <button onClick={() => makeTask(e)} disabled={tasked.has(e.id)} title="Create a task / reminder">
                    {tasked.has(e.id) ? <><Check size={13} /> Task added</> : <><Plus size={13} /> Task</>}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- Email composer assistant (disposable chat) ---------------------------

type EmailSource = { from: string; subject: string; snippet: string; ts: number };
type ECTurn = { role: "user" | "assistant"; content: string; display: string };

const COMPOSER_TONES = [
  { id: "professional", name: "Professional" },
  { id: "friendly", name: "Friendly" },
  { id: "concise", name: "Concise" },
  { id: "warm", name: "Warm" },
  { id: "formal", name: "Formal" },
];

function EmailComposer({ profile, source, onClose }: { profile: Profile; source?: EmailSource; onClose: () => void }) {
  const [tone, setTone] = useState("professional");
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ECTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const model: ModelId = profile.defaultModel?.startsWith("claude") ? profile.defaultModel : "claude-opus-4-8";

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const firstInstruction = (text: string) => {
    const toneName = COMPOSER_TONES.find((t) => t.id === tone)?.name || "Professional";
    if (source) {
      return (
        `Help me reply to the email below. Tone: ${toneName}. ` +
        `Respond with ONLY the email body — no subject line, no "Subject:", no preamble or commentary.\n\n` +
        `--- Email I'm replying to ---\nFrom: ${source.from}\nSubject: ${source.subject}\n\n${source.snippet}\n--- end of email ---\n\n` +
        `What I want to convey: ${text || "(write an appropriate, complete reply)"}`
      );
    }
    return (
      `Help me write and format this email. Tone: ${toneName}. ` +
      `Respond with ONLY the email body — no commentary.\n\n${text}`
    );
  };

  const send = async (rawText: string) => {
    const text = rawText.trim();
    const isFollowup = turns.length > 0;
    if ((!text && isFollowup) || streaming) return;
    const userContent = isFollowup ? text : firstInstruction(text);
    const userDisplay = text || (source ? "Draft a reply" : "Format / write this");
    const base = [...turns, { role: "user" as const, content: userContent, display: userDisplay }];
    setTurns([...base, { role: "assistant", content: "", display: "" }]);
    setInput("");
    setStreaming(true);
    const messages: Message[] = base.map((t, i) => ({ id: `ec-${i}`, role: t.role, content: t.content, ts: Date.now() }));
    try {
      let acc = "";
      for await (const ev of streamChat({ profile, model, messages, contextChips: [] })) {
        if (ev.type === "text") {
          acc += ev.v;
          setTurns((ts) => { const c = [...ts]; c[c.length - 1] = { role: "assistant", content: acc, display: acc }; return c; });
        }
      }
    } catch {
      setTurns((ts) => { const c = [...ts]; c[c.length - 1] = { role: "assistant", content: "⚠️ Couldn't reach the assistant.", display: "⚠️ Couldn't reach the assistant." }; return c; });
    } finally {
      setStreaming(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); }
  };

  return (
    <div className="ec-overlay" onClick={onClose}>
      <div className="ec-modal" onClick={(e) => e.stopPropagation()}>
        <div className="ec-head">
          <div className="ec-title">
            <Wand2 size={15} />
            {source ? <span>Reply to: <b>{source.subject || "(no subject)"}</b></span> : <span>Compose / format email</span>}
          </div>
          <span className="ec-disposable">disposable · not saved</span>
          <button className="ec-close" onClick={onClose}><X size={16} /></button>
        </div>

        {source && (
          <div className="ec-source">
            <div className="ec-source-meta">From {source.from}{source.ts ? ` · ${new Date(source.ts).toLocaleDateString()}` : ""}</div>
            <div className="ec-source-snip">{source.snippet}</div>
          </div>
        )}

        <div className="ec-transcript" ref={scroller}>
          {turns.length === 0 && (
            <div className="ec-hint">
              {source
                ? "Add a line on what you want to say (or leave blank), pick a tone, and I'll draft the reply. Then refine it conversationally."
                : "Paste rough notes or text to clean up, pick a tone, and I'll write/format the email. Then refine it."}
            </div>
          )}
          {turns.map((t, i) =>
            t.role === "user" ? (
              <div key={i} className="ec-user">{t.display}</div>
            ) : (
              <div key={i} className="ec-assistant">
                {t.content ? (
                  <>
                    <div className="ec-draft-text" dangerouslySetInnerHTML={{ __html: md(t.content) }} />
                    {!(streaming && i === turns.length - 1) && (
                      <button className="ec-copy" onClick={() => copyText(t.content)}><Copy size={12} /> Copy</button>
                    )}
                  </>
                ) : (
                  <span className="ec-typing"><Loader size={14} className="spin" /> drafting…</span>
                )}
              </div>
            ),
          )}
        </div>

        <div className="ec-composer">
          {turns.length === 0 && (
            <select value={tone} onChange={(e) => setTone(e.target.value)} title="Tone">
              {COMPOSER_TONES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <textarea
            value={input}
            placeholder={turns.length === 0 ? (source ? "What do you want to say? (optional)" : "Paste or describe the email…") : "Refine — e.g. “shorter”, “add a thank you”, “less formal”"}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <button className="ec-send" disabled={streaming || (turns.length > 0 && !input.trim())} onClick={() => send(input)}>
            {streaming ? <Loader size={15} className="spin" /> : <Send size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Summary: a person's profile at a glance -------------------------------

type SummarySection = "bio" | "family" | "interests" | "timeline" | "events" | "conversations";

// Pull bullet lines under any heading whose title matches one of `names`.
function extractMdSection(markdown: string, names: string[]): string[] {
  if (!markdown) return [];
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let capturing = false;
  for (const raw of lines) {
    const head = /^#{1,6}\s+(.*)$/.exec(raw);
    if (head) {
      const title = head[1].toLowerCase();
      capturing = names.some((n) => title.includes(n));
      continue;
    }
    if (!capturing) continue;
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      const t = bullet[1].replace(/\*\*/g, "").replace(/`/g, "").trim();
      if (t) out.push(t);
    }
  }
  return out;
}

type TimelineItem = {
  ts: number;
  kind: "chat" | "memory" | "event" | "task";
  title: string;
  sub?: string;
  convId?: string;
  nav?: ExploreTab;
};

// Parse a family-relations markdown file into a center person + related members.
type FamilyMember = { name: string; relation: string; detail?: string };
const REL_MAP: [RegExp, string][] = [
  [/partner|spouse|wife|husband/i, "partner"],
  [/child|children|son|daughter|kid/i, "child"],
  [/parent|mother|father|mom|dad/i, "parent"],
  [/sibling|brother|sister/i, "sibling"],
];
function normalizeRelation(label: string): string {
  for (const [re, rel] of REL_MAP) if (re.test(label)) return rel;
  return "relative";
}
function splitNames(s: string): { name: string; detail?: string }[] {
  return s
    .split(/,|\band\b|&|;/i)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^(.*?)\s*[—\-(]\s*(.*?)\)?$/.exec(x);
      if (m && m[2]) return { name: m[1].trim(), detail: m[2].replace(/[)]/g, "").trim() };
      return { name: x };
    });
}
function parseFamily(markdown: string, centerName: string): { center: string; members: FamilyMember[] } {
  const lines = (markdown || "").split(/\r?\n/);
  const members: FamilyMember[] = [];
  let current = "";
  let inImmediate = false;
  for (const raw of lines) {
    const head = /^#{1,6}\s+(.*)$/.exec(raw);
    if (head) { inImmediate = /immediate|family/i.test(head[1]); continue; }
    if (!inImmediate) continue;
    const labeled = /^\s*[-*]\s*\*\*(.+?):?\*\*\s*(.*)$/.exec(raw);
    if (labeled) {
      current = normalizeRelation(labeled[1]);
      const val = labeled[2].trim();
      if (val) for (const n of splitNames(val)) members.push({ ...n, relation: current });
      continue;
    }
    const nested = /^\s+[-*]\s+(.*)$/.exec(raw); // indented child bullet under a label
    if (nested && current) {
      for (const n of splitNames(nested[1])) members.push({ ...n, relation: current });
    }
  }
  // de-dupe by name
  const seen = new Set<string>();
  const uniq = members.filter((m) => m.name && !seen.has(m.name.toLowerCase()) && seen.add(m.name.toLowerCase()));
  return { center: centerName, members: uniq };
}

const REL_COLOR: Record<string, string> = {
  partner: "#C2548A", child: "#4A9DD8", parent: "#3BA776", sibling: "#E0903C", relative: "#7C6FF0",
};

function FamilyGraph({ data, accent }: { data: { center: string; members: FamilyMember[] }; accent: string }) {
  const { center, members } = data;
  const W = 460, H = 340, cx = W / 2, cy = H / 2;
  const n = members.length;
  const R = n <= 4 ? 120 : n <= 8 ? 135 : 145;
  const nodes = members.map((m, i) => {
    const ang = (-Math.PI / 2) + (i * 2 * Math.PI) / Math.max(1, n);
    return { ...m, x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
  });
  if (n === 0) return <p className="lookup-muted">No immediate family parsed. Add members under “## Immediate family”.</p>;
  return (
    <svg className="fam-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Family network graph">
      {nodes.map((nd, i) => (
        <line key={`e${i}`} x1={cx} y1={cy} x2={nd.x} y2={nd.y} className="fam-edge" stroke={REL_COLOR[nd.relation] || "#888"} />
      ))}
      {nodes.map((nd, i) => (
        <g key={`n${i}`} className="fam-node">
          <circle cx={nd.x} cy={nd.y} r={26} fill={REL_COLOR[nd.relation] || "#888"} />
          <text x={nd.x} y={nd.y - 1} className="fam-node-name">{nd.name}</text>
          {nd.detail && <text x={nd.x} y={nd.y + 11} className="fam-node-detail">{nd.detail}</text>}
          <text x={nd.x} y={nd.y + 42} className="fam-node-rel">{nd.relation}</text>
        </g>
      ))}
      <circle cx={cx} cy={cy} r={34} fill={accent} className="fam-center-c" />
      <text x={cx} y={cy + 1} className="fam-center-name">{center}</text>
    </svg>
  );
}

// Render timeline items onto a month calendar grid.
function TimelineCalendar({
  items,
  onOpen,
  onTabChange,
}: {
  items: TimelineItem[];
  onOpen: (id: string) => void;
  onTabChange: (t: ExploreTab) => void;
}) {
  const [off, setOff] = useState(0);
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + off);
  const year = base.getFullYear();
  const month = base.getMonth();
  const startW = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const today = sod(Date.now());
  const byDay = useMemo(() => {
    const m = new Map<number, TimelineItem[]>();
    for (const it of items) {
      const k = sod(it.ts);
      (m.get(k) ?? m.set(k, []).get(k)!).push(it);
    }
    return m;
  }, [items]);
  const cells: (number | null)[] = [];
  for (let i = 0; i < startW; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const go = (it: TimelineItem) => (it.convId ? onOpen(it.convId) : it.nav ? onTabChange(it.nav) : undefined);
  return (
    <div className="cal sm-tl-cal">
      <div className="view-nav">
        <button className="icon-btn" onClick={() => setOff((o) => o - 1)}><ChevronLeft size={18} /></button>
        <h3>{base.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>
        <button className="icon-btn" onClick={() => setOff((o) => o + 1)}><ChevronRight size={18} /></button>
      </div>
      <div className="cal-grid cal-dow">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="cal-dow-cell">{d}</div>)}
      </div>
      <div className="cal-grid cal-body">
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="cal-cell empty" />;
          const k = new Date(year, month, d).setHours(0, 0, 0, 0);
          const list = byDay.get(k) || [];
          return (
            <div key={i} className={`cal-cell ${k === today ? "today" : ""}`}>
              <div className="cal-cell-head"><span className="cal-day">{d}</span></div>
              <div className="cal-chips">
                {list.slice(0, 4).map((it, j) => (
                  <button
                    key={j}
                    className={`cal-chip ${it.convId || it.nav ? "" : "static"}`}
                    style={{ borderLeftColor: { chat: "#4A9DD8", memory: "#7C6FF0", event: "#3BA776", task: "#E0903C" }[it.kind] }}
                    title={`${it.title}${it.sub ? ` — ${it.sub}` : ""}`}
                    onClick={() => go(it)}
                  >
                    {it.title}
                  </button>
                ))}
                {list.length > 4 && <span className="cal-more">+{list.length - 4} more</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryView({
  chats,
  onOpen,
  onTabChange,
}: {
  chats: Conversation[];
  onOpen: (id: string) => void;
  onTabChange: (t: ExploreTab) => void;
}) {
  const { activeProfile, reminders, memory, memoryFiles } = useStore();
  const [section, setSection] = useState<SummarySection | null>(null);
  const [details, setDetails] = useState<ProfileDetails | null>(null);
  const [family, setFamily] = useState<string>("");
  const [familyView, setFamilyView] = useState<"graph" | "text">("graph");
  const [tlView, setTlView] = useState<"calendar" | "list">("calendar");

  useEffect(() => {
    if (!activeProfile) return;
    setDetails(null);
    setFamily("");
    api.getDetails(activeProfile.id).then(setDetails).catch(() => {});
    api.getFamily(activeProfile.id).then((r) => setFamily(r.family)).catch(() => {});
  }, [activeProfile?.id]);

  // --- Derived data ---------------------------------------------------------
  const bio = (details?.bio || activeProfile?.persona || "").trim();

  // Interests: durable interests/themes from LTM + most-used conversation concepts.
  const interests = useMemo(() => {
    const fromLtm = extractMdSection(memoryFiles.ltm, ["interest", "theme", "passion"]);
    const freq = new Map<string, number>();
    for (const c of chats) for (const t of c.concepts || []) {
      const k = t.trim();
      if (k) freq.set(k, (freq.get(k) || 0) + 1);
    }
    const fromTopics = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const t of [...fromLtm, ...fromTopics]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(t);
    }
    return merged.slice(0, 24);
  }, [memoryFiles.ltm, chats]);

  // Timeline: conversations, memorized memories, and dated reminders/events.
  const timeline = useMemo(() => {
    const items: TimelineItem[] = [];
    for (const c of chats)
      items.push({ ts: c.createdAt, kind: "chat", title: c.title, sub: `${c.messages.length} messages`, convId: c.id });
    for (const m of memory)
      items.push({ ts: m.createdAt, kind: "memory", title: m.subject || "Memory", sub: cleanSnippet(m.body, 80), convId: m.conversationId });
    for (const r of reminders)
      items.push({
        ts: r.dueAt,
        kind: r.source === "gcal" ? "event" : "task",
        title: r.text,
        sub: r.source === "gcal" ? "calendar event" : r.source === "gmail" ? "from email" : "reminder",
        nav: r.source === "gcal" ? "calendar" : undefined,
      });
    return items.sort((a, b) => b.ts - a.ts);
  }, [chats, memory, reminders]);

  // Recent important events: upcoming + just-passed calendar/email items and pinned chats.
  const events = useMemo(() => {
    const now = Date.now();
    return reminders
      .filter((r) => !r.done)
      .map((r) => ({ r, dist: Math.abs(r.dueAt - now), upcoming: r.dueAt >= now - DAY_MS }))
      .filter((x) => x.upcoming || x.dist < 14 * DAY_MS)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 12)
      .map((x) => x.r);
  }, [reminders]);

  // Important conversations: pinned first, then memorized/summarized, then most active.
  const importantChats = useMemo(() => {
    const memById = new Set(memory.map((m) => m.conversationId).filter(Boolean));
    const score = (c: Conversation) =>
      (c.pinned ? 1000 : 0) + (memById.has(c.id) ? 500 : 0) + (c.summary ? 200 : 0) + c.messages.length;
    return [...chats].sort((a, b) => score(b) - score(a)).slice(0, 12);
  }, [chats, memory]);

  if (!activeProfile) return <div className="lookup-muted">No profile selected.</div>;

  const fmtDate = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const monthKey = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "long" });

  // --- Section detail views -------------------------------------------------
  if (section) {
    const titles: Record<SummarySection, string> = {
      bio: "Bio", family: "Family", interests: "Interests",
      timeline: "Timeline", events: "Recent important events", conversations: "Important conversations",
    };
    return (
      <div className="summary-view">
        <div className="sm-detail-head">
          <button className="sm-back" onClick={() => setSection(null)}>
            <ArrowLeft size={15} /> Summary
          </button>
          <h2>{titles[section]}</h2>
        </div>

        {section === "bio" && (
          <div className="sm-detail-body">
            {bio ? (
              <div className="sm-prose" dangerouslySetInnerHTML={{ __html: md(bio) }} />
            ) : (
              <p className="lookup-muted">No bio yet. Add one in ⚙ Profile settings → Personal details.</p>
            )}
            {memoryFiles.ltm && (
              <>
                <div className="pf-sec-h">Long-term memory</div>
                <div className="sm-prose" dangerouslySetInnerHTML={{ __html: md(memoryFiles.ltm) }} />
              </>
            )}
          </div>
        )}

        {section === "family" && (
          <div className="sm-detail-body">
            <div className="sm-toggle">
              <button className={familyView === "graph" ? "active" : ""} onClick={() => setFamilyView("graph")}><Network size={13} /> Graph</button>
              <button className={familyView === "text" ? "active" : ""} onClick={() => setFamilyView("text")}><FileText size={13} /> Text</button>
            </div>
            {familyView === "graph" ? (
              <>
                <FamilyGraph data={parseFamily(family, details?.name || activeProfile.name)} accent={activeProfile.color} />
                <div className="fam-legend">
                  {Object.entries(REL_COLOR).map(([rel, col]) => (
                    <span key={rel}><i style={{ background: col }} /> {rel}</span>
                  ))}
                </div>
              </>
            ) : family.trim() ? (
              <div className="sm-prose" dangerouslySetInnerHTML={{ __html: md(family) }} />
            ) : (
              <p className="lookup-muted">No family details yet — edit personal-claude/bio/&lt;name&gt;_family.md.</p>
            )}
          </div>
        )}

        {section === "interests" && (
          <div className="sm-detail-body">
            {interests.length ? (
              <div className="sm-chips">
                {interests.map((t) => (
                  <button key={t} className="sm-chip" onClick={() => onTabChange("topics")} title="Explore in Topics">
                    {t}
                  </button>
                ))}
              </div>
            ) : (
              <p className="lookup-muted">No interests inferred yet — they build up from your topics and long-term memory.</p>
            )}
          </div>
        )}

        {section === "timeline" && (
          <div className="sm-detail-body">
            <div className="sm-toggle">
              <button className={tlView === "calendar" ? "active" : ""} onClick={() => setTlView("calendar")}><CalIcon size={13} /> Calendar</button>
              <button className={tlView === "list" ? "active" : ""} onClick={() => setTlView("list")}><History size={13} /> List</button>
            </div>
            {timeline.length === 0 ? (
              <p className="lookup-muted">Nothing on the timeline yet.</p>
            ) : tlView === "calendar" ? (
              <TimelineCalendar items={timeline} onOpen={onOpen} onTabChange={onTabChange} />
            ) : (
              <div className="sm-timeline">
                {timeline.map((it, i) => {
              const showMonth = i === 0 || monthKey(it.ts) !== monthKey(timeline[i - 1].ts);
              return (
                <Fragment key={i}>
                  {showMonth && <div className="sm-tl-month">{monthKey(it.ts)}</div>}
                  <button
                    className={`sm-tl-item ${it.convId || it.nav ? "clickable" : ""}`}
                    onClick={() => (it.convId ? onOpen(it.convId) : it.nav ? onTabChange(it.nav) : undefined)}
                  >
                    <span className={`sm-tl-dot ${it.kind}`} />
                    <span className="sm-tl-main">
                      <span className="sm-tl-title">{it.title}</span>
                      {it.sub && <span className="sm-tl-sub">{it.sub}</span>}
                    </span>
                    <span className="sm-tl-date">{fmtDate(it.ts)}</span>
                  </button>
                </Fragment>
              );
                })}
              </div>
            )}
          </div>
        )}

        {section === "events" && (
          <div className="sm-detail-body">
            {events.length === 0 ? (
              <p className="lookup-muted">No upcoming events or due tasks.</p>
            ) : (
              <ul className="pf-rem-list sm-event-list">
                {events.map((r) => (
                  <li key={r.id} onClick={() => onTabChange(r.source === "gcal" ? "calendar" : "weekly")}>
                    <span className="sm-ev-icon">{r.source === "gcal" ? "📅" : r.source === "gmail" ? "✉️" : "🔔"}</span>
                    <span className="pf-rem-text">{r.text}</span>
                    <span className="pf-rem-due">{fmtDate(r.dueAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {section === "conversations" && (
          <div className="sm-detail-body">
            {importantChats.length === 0 ? (
              <p className="lookup-muted">No conversations yet.</p>
            ) : (
              <ul className="sm-conv-list">
                {importantChats.map((c) => (
                  <li key={c.id} onClick={() => onOpen(c.id)}>
                    <div className="sm-conv-top">
                      {c.pinned && <Pin size={12} />}
                      <span className="sm-conv-title">{c.title}</span>
                      <span className="pf-rem-due">{relTime(c.updatedAt)}</span>
                    </div>
                    {c.summary && <div className="sm-conv-sub">{cleanSnippet(c.summary, 120)}</div>}
                    {c.concepts?.length > 0 && (
                      <div className="sm-conv-tags">
                        {c.concepts.slice(0, 5).map((t) => <span key={t} className="sm-tag">{t}</span>)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    );
  }

  // --- Overview -------------------------------------------------------------
  const cards: { key: SummarySection; icon: React.ReactNode; title: string; count?: number; preview: React.ReactNode }[] = [
    { key: "bio", icon: <User size={16} />, title: "Bio", preview: bio ? cleanSnippet(bio, 140) : "Add a short bio in profile settings." },
    { key: "family", icon: <Users size={16} />, title: "Family", preview: family.trim() ? cleanSnippet(family.replace(/^#.*$/m, ""), 140) : "No family details yet." },
    { key: "interests", icon: <Sparkles size={16} />, title: "Interests", count: interests.length, preview: interests.length ? interests.slice(0, 6).join(" · ") : "Builds from topics & memory." },
    { key: "timeline", icon: <History size={16} />, title: "Timeline", count: timeline.length, preview: timeline.length ? `From ${fmtDate(timeline[timeline.length - 1].ts)} to ${fmtDate(timeline[0].ts)}` : "Nothing yet." },
    { key: "events", icon: <CalendarClock size={16} />, title: "Recent important events", count: events.length, preview: events.length ? events.slice(0, 3).map((r) => cleanSnippet(r.text, 32)).join(" · ") : "No upcoming events." },
    { key: "conversations", icon: <Star size={16} />, title: "Important conversations", count: importantChats.length, preview: importantChats.length ? cleanSnippet(importantChats[0].title, 120) : "No conversations yet." },
  ];

  return (
    <div className="summary-view">
      <header className="sm-hero">
        <div className="sm-avatar" style={{ background: activeProfile.color }}>
          {activeProfile.avatar || activeProfile.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="sm-hero-main">
          <h1>{details?.name || activeProfile.name}</h1>
          {(details?.role || activeProfile.tagline) && <div className="sm-tagline">{details?.role || activeProfile.tagline}</div>}
          <div className="sm-meta">
            {details?.location && <span><MapPin size={12} /> {details.location}</span>}
            {details?.role && <span><Briefcase size={12} /> {details.role}</span>}
            {details?.websites?.filter(Boolean).map((w) => (
              <a key={w} href={w} target="_blank" rel="noreferrer"><LinkIcon size={12} /> {w.replace(/^https?:\/\//, "")}</a>
            ))}
          </div>
        </div>
      </header>

      <div className="sm-cards">
        {cards.map((c) => (
          <button key={c.key} className="sm-card" onClick={() => setSection(c.key)}>
            <div className="sm-card-head">
              <span className="sm-card-icon">{c.icon}</span>
              <span className="sm-card-title">{c.title}</span>
              {c.count !== undefined && <span className="sm-card-count">{c.count}</span>}
              <ChevronRight size={15} className="sm-card-arrow" />
            </div>
            <div className="sm-card-preview">{c.preview}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- LinkedIn manager: inbox reply pipeline + post studio ------------------

function copyText(t: string) {
  navigator.clipboard?.writeText(t).catch(() => {});
}

function LinkedInView() {
  const [sub, setSub] = useState<"inbox" | "studio" | "outreach">("inbox");
  return (
    <div className="li-view">
      <div className="li-subtabs">
        <button className={sub === "inbox" ? "active" : ""} onClick={() => setSub("inbox")}>
          <Inbox size={14} /> Inbox &amp; replies
        </button>
        <button className={sub === "studio" ? "active" : ""} onClick={() => setSub("studio")}>
          <Wand2 size={14} /> Post studio
        </button>
        <button className={sub === "outreach" ? "active" : ""} onClick={() => setSub("outreach")}>
          <Send size={14} /> Outreach
        </button>
      </div>
      <div className="li-note">
        <Linkedin size={13} /> Drafts are prepared locally and held behind a manual approval gate — nothing is posted to LinkedIn automatically.
      </div>
      {sub === "inbox" ? <LiInbox /> : sub === "studio" ? <LiStudio /> : <LiOutreach />}
    </div>
  );
}

const TONES = [
  { id: "professional", name: "Professional" },
  { id: "friendly", name: "Friendly" },
  { id: "concise", name: "Concise" },
  { id: "enthusiastic", name: "Enthusiastic" },
];

function recClass(r?: string) {
  return r === "approve" ? "good" : r === "review" ? "warn" : "bad";
}

function LiInbox() {
  const { activeProfile } = useStore();
  const [messages, setMessages] = useState<LiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ sender: "", headline: "", text: "" });

  const load = () => {
    if (!activeProfile) return;
    api.liMessages(activeProfile.id).then((r) => setMessages(r.messages)).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { setLoading(true); load(); }, [activeProfile?.id]);

  const pid = activeProfile?.id;
  const process = async (id: string, tone?: string) => {
    if (!pid) return;
    setBusy(id);
    try { await api.liProcess(pid, id, tone ? { tone } : undefined); load(); }
    finally { setBusy(null); }
  };
  const approve = async (m: LiMessage) => {
    if (!pid || !m.draft) return;
    const r = await api.liApprove(pid, m.draft.id);
    copyText(r.reply);
    load();
  };
  const reject = async (m: LiMessage) => {
    if (!pid || !m.draft) return;
    await api.liReject(pid, m.draft.id); load();
  };
  const editBody = async (m: LiMessage, body: string) => {
    setMessages((ms) => ms.map((x) => (x.id === m.id && x.draft ? { ...x, draft: { ...x.draft, body } } : x)));
  };
  const saveBody = async (m: LiMessage) => {
    if (!pid || !m.draft) return;
    await api.liEditDraft(pid, m.draft.id, { body: m.draft.body });
  };
  const seed = async () => { if (!pid) return; await api.liSeedDemo(pid); load(); };
  const del = async (id: string) => { if (!pid) return; await api.liDeleteMessage(pid, id); load(); };
  const submitAdd = async () => {
    if (!pid || !form.text.trim()) return;
    await api.liIngest(pid, { ...form, autoProcess: true });
    setForm({ sender: "", headline: "", text: "" }); setAdding(false); load();
  };

  return (
    <div className="li-inbox">
      <div className="li-bar">
        <span className="ev-count">{messages.length} messages</span>
        <div className="li-bar-actions">
          <button className="btn-secondary" onClick={() => setAdding((v) => !v)}><Plus size={13} /> Add message</button>
          <button className="btn-secondary" onClick={seed}><Database size={13} /> Seed demo</button>
          <button className="btn-secondary" onClick={load}><RefreshCw size={13} /> Refresh</button>
        </div>
      </div>
      {adding && (
        <div className="li-add">
          <div className="li-add-row">
            <input placeholder="Sender" value={form.sender} onChange={(e) => setForm({ ...form, sender: e.target.value })} />
            <input placeholder="Headline (optional)" value={form.headline} onChange={(e) => setForm({ ...form, headline: e.target.value })} />
          </div>
          <textarea placeholder="Paste the inbound LinkedIn message…" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
          <div className="li-add-actions">
            <button className="new-chat-btn" disabled={!form.text.trim()} onClick={submitAdd}>Add &amp; draft reply</button>
            <button className="btn-secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="lookup-muted">Loading…</div>
      ) : messages.length === 0 ? (
        <div className="lookup-muted">No messages yet. “Seed demo” to try the pipeline, or POST scraped messages to <code>/api/profiles/{pid}/linkedin/messages</code>.</div>
      ) : (
        <ul className="li-msg-list">
          {messages.map((m) => (
            <li key={m.id} className="li-msg">
              <div className="li-msg-head">
                <div className="li-msg-who">
                  <span className="li-msg-sender">{m.sender || "Unknown"}</span>
                  {m.headline && <span className="li-msg-headline">{m.headline}</span>}
                </div>
                <button className="li-icon" title="Delete" onClick={() => del(m.id)}><Trash2 size={13} /></button>
              </div>
              <div className="li-msg-text">{m.text}</div>
              {m.intent && (
                <div className="li-chips">
                  <span className={`li-chip intent-${m.intent}`}>{m.intent}</span>
                  <span className="li-chip">priority: {m.priority}</span>
                  <span className="li-chip">urgency: {m.urgency}</span>
                  <span className="li-chip">{m.sentiment}</span>
                </div>
              )}
              {!m.draft ? (
                <button className="li-run" disabled={busy === m.id} onClick={() => process(m.id)}>
                  {busy === m.id ? <><Loader size={13} className="spin" /> Running pipeline…</> : <><Wand2 size={13} /> Draft a reply</>}
                </button>
              ) : (
                <div className={`li-draft ${m.draft.status}`}>
                  <div className="li-draft-head">
                    <span className={`li-rec ${recClass(m.draft.recommendation)}`}>{m.draft.recommendation}</span>
                    <span className="li-scores">
                      Q {m.draft.qualityScore} · rel {m.draft.relevance} · compl {m.draft.completeness} · tone {m.draft.toneOk}
                    </span>
                    <span className={`li-status s-${m.draft.status}`}>{m.draft.status}</span>
                  </div>
                  <textarea
                    className="li-draft-body"
                    value={m.draft.body}
                    onChange={(e) => editBody(m, e.target.value)}
                    onBlur={() => saveBody(m)}
                  />
                  <div className="li-draft-actions">
                    <select
                      value={m.draft.tone || "professional"}
                      onChange={(e) => process(m.id, e.target.value)}
                      title="Re-draft with tone"
                    >
                      {TONES.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <button onClick={() => process(m.id, m.draft?.tone || undefined)} disabled={busy === m.id} title="Re-run pipeline">
                      <RefreshCw size={13} /> Redraft
                    </button>
                    <button onClick={() => copyText(m.draft!.body)}><Copy size={13} /> Copy</button>
                    <button className="li-approve" onClick={() => approve(m)} disabled={m.draft.status === "approved"}>
                      <ThumbsUp size={13} /> {m.draft.status === "approved" ? "Approved · copied" : "Approve"}
                    </button>
                    <button className="li-reject" onClick={() => reject(m)}><ThumbsDown size={13} /> Reject</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LiStudio() {
  const { activeProfile } = useStore();
  const [templates, setTemplates] = useState<LiTemplate[]>([]);
  const [posts, setPosts] = useState<LiPost[]>([]);
  const [tpl, setTpl] = useState("thought-leadership");
  const [topic, setTopic] = useState("");
  const [draft, setDraft] = useState<{ title: string; body: string; hashtags: string[] } | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [when, setWhen] = useState("");

  const pid = activeProfile?.id;
  const load = () => {
    if (!pid) return;
    api.liTemplates(pid).then((r) => setTemplates(r.post)).catch(() => {});
    api.liPosts(pid).then((r) => setPosts(r.posts)).catch(() => {});
  };
  useEffect(() => { load(); }, [pid]);

  const generate = async () => {
    if (!pid) return;
    setDrafting(true);
    try { setDraft(await api.liDraftPost(pid, { template: tpl, topic })); }
    finally { setDrafting(false); }
  };
  const save = async (status: string) => {
    if (!pid || !draft) return;
    await api.liAddPost(pid, {
      kind: "post", template: tpl, topic, title: draft.title, body: draft.body,
      hashtags: draft.hashtags, status, scheduledAt: when ? new Date(when).getTime() : null,
    });
    setDraft(null); setTopic(""); setWhen(""); load();
  };
  const setStatus = async (p: LiPost, status: string) => { if (pid) { await api.liUpdatePost(pid, p.id, { status }); load(); } };
  const del = async (id: string) => { if (pid) { await api.liDeletePost(pid, id); load(); } };

  const STAGES = ["idea", "draft", "ready", "scheduled", "posted"];

  return (
    <div className="li-studio">
      <div className="li-compose">
        <div className="li-compose-row">
          <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input placeholder="Topic / angle (optional)" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <button className="new-chat-btn" disabled={drafting} onClick={generate}>
            {drafting ? <><Loader size={14} className="spin" /> Drafting…</> : <><Wand2 size={14} /> Draft with AI</>}
          </button>
        </div>
        {templates.find((t) => t.id === tpl) && (
          <div className="li-tpl-hint">{templates.find((t) => t.id === tpl)!.structure}</div>
        )}
        {draft && (
          <div className="li-draft-card">
            <input className="li-draft-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <textarea className="li-post-body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            {draft.hashtags.length > 0 && <div className="li-hashtags">{draft.hashtags.join("  ")}</div>}
            <div className="li-draft-actions">
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} title="Schedule (optional)" />
              <button onClick={() => copyText(`${draft.body}${draft.hashtags.length ? "\n\n" + draft.hashtags.join(" ") : ""}`)}><Copy size={13} /> Copy</button>
              <button className="btn-secondary" onClick={() => save("draft")}>Save draft</button>
              <button className="new-chat-btn" onClick={() => save(when ? "scheduled" : "ready")}>{when ? "Schedule" : "Mark ready"}</button>
            </div>
          </div>
        )}
      </div>

      <div className="li-pipeline-cols">
        {STAGES.map((s) => {
          const items = posts.filter((p) => p.status === s);
          return (
            <div key={s} className="li-col">
              <div className="li-col-head">{s} <span className="pf-count">{items.length}</span></div>
              {items.map((p) => (
                <div key={p.id} className="li-post-card">
                  <div className="li-post-title">{p.title || p.topic || "Untitled"}</div>
                  <div className="li-post-snip">{cleanSnippet(p.body, 90)}</div>
                  {p.scheduledAt && <div className="li-post-when">📅 {new Date(p.scheduledAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</div>}
                  <div className="li-post-actions">
                    <button onClick={() => copyText(`${p.body}${p.hashtags.length ? "\n\n" + p.hashtags.join(" ") : ""}`)} title="Copy"><Copy size={12} /></button>
                    <select value={p.status} onChange={(e) => setStatus(p, e.target.value)}>
                      {STAGES.map((x) => <option key={x} value={x}>{x}</option>)}
                    </select>
                    <button onClick={() => del(p.id)} title="Delete"><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LiOutreach() {
  const { activeProfile } = useStore();
  const [templates, setTemplates] = useState<LiTemplate[]>([]);
  const [tpl, setTpl] = useState("connection-note");
  const [topic, setTopic] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);

  const pid = activeProfile?.id;
  useEffect(() => {
    if (!pid) return;
    api.liTemplates(pid).then((r) => setTemplates(r.outreach)).catch(() => {});
  }, [pid]);

  const generate = async () => {
    if (!pid) return;
    setBusy(true);
    try { const r = await api.liDraftPost(pid, { template: tpl, topic, kind: "outreach" }); setOut(r.body); }
    finally { setBusy(false); }
  };

  const current = templates.find((t) => t.id === tpl);
  return (
    <div className="li-outreach">
      <div className="li-compose-row">
        <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <input placeholder="Who / context (e.g. 'met at re:Invent, works on ML infra')" value={topic} onChange={(e) => setTopic(e.target.value)} />
        <button className="new-chat-btn" disabled={busy} onClick={generate}>
          {busy ? <><Loader size={14} className="spin" /> Writing…</> : <><Wand2 size={14} /> Personalize</>}
        </button>
      </div>
      {current && <div className="li-tpl-hint">{current.structure}</div>}
      {out && (
        <div className="li-draft-card">
          <textarea className="li-post-body" value={out} onChange={(e) => setOut(e.target.value)} />
          <div className="li-draft-actions">
            <button onClick={() => copyText(out)}><Copy size={13} /> Copy</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Pipeline: the dynamic flow every conversation travels -----------------

const DAY_MS = 86_400_000;

function FlowEdge({ d, active }: { d: string; active: boolean }) {
  return (
    <g>
      <path d={d} className={`pf-edge ${active ? "active" : ""}`} />
      {[0, 1, 2].map((i) => (
        <circle key={i} r={0.7} className={`pf-dot ${active ? "active" : ""}`}>
          <animateMotion dur="2.4s" begin={`${i * 0.8}s`} repeatCount="indefinite" path={d} />
        </circle>
      ))}
    </g>
  );
}

function PipelineFlow({
  chats,
  onOpen,
  onTabChange,
  selectedId,
  onSelectId,
}: {
  chats: Conversation[];
  onOpen: (id: string) => void;
  onTabChange: (t: ExploreTab) => void;
  selectedId?: string | null;
  onSelectId?: (id: string) => void;
}) {
  const { memory, memoryFiles, notes, reminders, toggleReminder } = useStore();
  const [localSel, setLocalSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<null | "stm" | "ltm" | "reminders">(null);
  // Controlled by the sidebar's "show in pipeline" when provided, else local.
  const selId = selectedId ?? localSel;
  const setSelId = (id: string) => (onSelectId ? onSelectId(id) : setLocalSel(id));

  const ordered = useMemo(() => [...chats].sort((a, b) => b.updatedAt - a.updatedAt), [chats]);
  const sel = ordered.find((c) => c.id === selId) || ordered[0] || null;

  // The selected conversation's CONCRETE output at each pipeline stage.
  const trace = useMemo(() => {
    if (!sel) return null;
    const memEntries = memory.filter((m) => m.conversationId === sel.id);
    const note = notes.find((n) => n.conversationId === sel.id);
    const summary = sel.summary || memEntries[0]?.body || note?.body || "";
    const related: { id: string; title: string; shared: string[] }[] = [];
    for (const c of chats) {
      if (c.id === sel.id) continue;
      const shared = sel.concepts.filter((k) => c.concepts.includes(k));
      if (shared.length) related.push({ id: c.id, title: c.title, shared });
    }
    related.sort((a, b) => b.shared.length - a.shared.length);
    const firstUser = sel.messages.find((m) => m.role === "user")?.content || "";
    return {
      summary,
      topics: sel.concepts,
      related,
      memEntries,
      firstUser,
      msgs: sel.messages.length,
    };
  }, [sel, chats, memory, notes]);

  const stats = useMemo(() => {
    const total = chats.length;
    const summarized = chats.filter((c) => c.summary).length;
    const tagged = chats.filter((c) => c.concepts.length > 0).length;
    const distinctTopics = new Set(chats.flatMap((c) => c.concepts)).size;
    // knowledge-graph relations: conversations that share ≥1 concept
    const conceptToChats = new Map<string, string[]>();
    for (const c of chats)
      for (const k of new Set(c.concepts)) (conceptToChats.get(k) || conceptToChats.set(k, []).get(k)!).push(c.id);
    const edgeSet = new Set<string>();
    const linked = new Set<string>();
    for (const ids of conceptToChats.values()) {
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
          edgeSet.add(key);
          linked.add(ids[i]);
          linked.add(ids[j]);
        }
    }
    const now = ordered[0]?.updatedAt || Date.now();
    const recent = chats.filter((c) => now - c.updatedAt <= 14 * DAY_MS).length;
    const memorizedIds = new Set(memory.map((m) => m.conversationId).filter(Boolean) as string[]);
    return {
      total,
      summarized,
      tagged,
      distinctTopics,
      edges: edgeSet.size,
      linked: linked.size,
      recent,
      memorized: memory.length,
      memorizedIds,
      linkedIds: linked,
    };
  }, [chats, memory, ordered]);

  // per-conversation completion for the selected chat
  const now = ordered[0]?.updatedAt || Date.now();
  const done = sel
    ? {
        conv: true,
        summarize: !!sel.summary,
        topics: sel.concepts.length > 0,
        kg: stats.linkedIds.has(sel.id),
        stm: now - sel.updatedAt <= 14 * DAY_MS,
        ltm: stats.memorizedIds.has(sel.id),
      }
    : null;

  // external-data flow counts (Gmail/Calendar sync → reminders)
  const emailTasks = reminders.filter((r) => r.source === "gmail").length;
  const calEvents = reminders.filter((r) => r.source === "gcal").length;
  const openReminders = reminders.filter((r) => !r.done).length;

  // Two lanes in a 100 x 50 space: conversations (top) + external data (bottom),
  // both converging on short- & long-term memory. `ext` nodes aren't part of a
  // single conversation's trace (no per-chat ✓).
  const nodes = [
    // conversation lane
    { key: "conv", x: 8, y: 14, icon: <MessageSquare size={17} />, label: "Conversation", value: stats.total, sub: "chats", done: done?.conv, ext: false, nav: null as ExploreTab | null, dialog: null, tip: trace ? `${trace.msgs} msgs` : "" },
    { key: "summarize", x: 26, y: 14, icon: <FileText size={17} />, label: "Summarize", value: stats.summarized, sub: `of ${stats.total}`, done: done?.summarize, ext: false, nav: null as ExploreTab | null, dialog: null, tip: trace?.summary ? cleanSnippet(trace.summary, 40) : "—" },
    { key: "topics", x: 45, y: 14, icon: <Tag size={17} />, label: "Topics", value: stats.distinctTopics, sub: `${stats.tagged} tagged`, done: done?.topics, ext: false, nav: "topics" as ExploreTab, dialog: null, tip: trace?.topics.length ? trace.topics.slice(0, 3).join(", ") : "—" },
    { key: "kg", x: 66, y: 7, icon: <Network size={17} />, label: "Knowledge graph", value: stats.edges, sub: `${stats.linked} linked`, done: done?.kg, ext: false, nav: "graph" as ExploreTab, dialog: null, tip: trace ? `${trace.related.length} related` : "" },
    // external-data lane
    { key: "gmail", x: 8, y: 33, icon: <Mail size={17} />, label: "Gmail", value: emailTasks, sub: "email tasks", done: null, ext: true, nav: "emails" as ExploreTab, dialog: null, tip: "" },
    { key: "calendar", x: 8, y: 45, icon: <CalIcon size={17} />, label: "Calendar", value: calEvents, sub: "events", done: null, ext: true, nav: "calendar" as ExploreTab, dialog: null, tip: "" },
    { key: "reminders", x: 28, y: 39, icon: <Bell size={17} />, label: "Reminders / tasks", value: openReminders, sub: "open", done: null, ext: true, nav: null as ExploreTab | null, dialog: "reminders" as const, tip: "" },
    // memory (both lanes converge)
    { key: "stm", x: 62, y: 28, icon: <Clock size={17} />, label: "Short-term (STM)", value: stats.recent, sub: memoryFiles.stmUpdated ? `built ${relTime(memoryFiles.stmUpdated)}` : "recent", done: done?.stm, ext: false, nav: null as ExploreTab | null, dialog: "stm" as const, tip: done?.stm ? "in window" : "aged out" },
    { key: "ltm", x: 85, y: 32, icon: <Brain size={17} />, label: "Long-term (LTM)", value: stats.memorized, sub: memoryFiles.ltmUpdated ? `built ${relTime(memoryFiles.ltmUpdated)}` : "memorized", done: done?.ltm, ext: false, nav: null as ExploreTab | null, dialog: "ltm" as const, tip: trace?.memEntries.length ? "memorized" : "—" },
  ];
  const pos: Record<string, { x: number; y: number }> = Object.fromEntries(nodes.map((n) => [n.key, { x: n.x, y: n.y }]));
  const edge = (a: string, b: string, bow = 0) => {
    const p = pos[a];
    const q = pos[b];
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2 + bow;
    return `M ${p.x} ${p.y} Q ${mx} ${my} ${q.x} ${q.y}`;
  };
  const edges = [
    { d: edge("conv", "summarize"), on: !!done?.summarize },
    { d: edge("summarize", "topics"), on: !!done?.topics },
    { d: edge("topics", "kg", -2), on: !!done?.kg },
    { d: edge("topics", "stm", 2), on: !!done?.stm },
    { d: edge("gmail", "reminders", -1), on: true },
    { d: edge("calendar", "reminders", 1), on: true },
    { d: edge("reminders", "stm", -2), on: true },
    { d: edge("stm", "ltm"), on: !!done?.ltm },
  ];

  return (
    <div className="pipeline-view">
      <div className="pf-controls">
        <span className="pf-controls-label">Trace a conversation:</span>
        <select
          value={sel?.id || ""}
          onChange={(e) => setSelId(e.target.value)}
          style={{ color: sel ? SOURCE_COLOR[sel.source || "claude"] : undefined, fontWeight: 600 }}
        >
          {ordered.slice(0, 200).map((c) => (
            <option key={c.id} value={c.id} style={{ color: SOURCE_COLOR[c.source || "claude"] }}>
              {(SOURCE_LABEL[c.source || "claude"] || "")} {c.title.slice(0, 50)}
            </option>
          ))}
        </select>
        {sel && (
          <button className="btn-secondary" onClick={() => onOpen(sel.id)}>
            Open <ArrowRight size={14} />
          </button>
        )}
      </div>

      <div className="pipeline-wrap">
        <svg className="pf-svg" viewBox="0 0 100 50" preserveAspectRatio="none">
          {edges.map((e, i) => (
            <FlowEdge key={i} d={e.d} active={e.on} />
          ))}
        </svg>
        {nodes.map((n) => (
          <div
            key={n.key}
            className={`pf-node ${n.ext ? "pf-ext" : n.done ? "done" : "pending"} ${sel && !n.ext && !n.done ? "unreached" : ""} ${n.nav || n.dialog ? "clickable" : ""}`}
            style={{ left: `${n.x}%`, top: `${(n.y / 50) * 100}%` }}
            onClick={() => (n.dialog ? setDetail(n.dialog) : n.nav ? onTabChange(n.nav) : undefined)}
            title={n.dialog ? "Open contents" : n.nav ? "Open this view" : undefined}
          >
            <div className="pf-node-head">
              <span className="pf-ico">{n.icon}</span>
              {sel && !n.ext && (
                <span className={`pf-flag ${n.done ? "done" : ""}`}>
                  {n.done ? <Check size={12} /> : "○"}
                </span>
              )}
            </div>
            <div className="pf-num">{n.value}</div>
            <div className="pf-label">{n.label}</div>
            <div className="pf-sub">{n.sub}</div>
            {sel && !n.ext && <div className="pf-trace" title={n.tip}>{n.tip}</div>}
          </div>
        ))}
      </div>

      {sel && trace && (
        <div className="pf-detail">
          <div className="pf-detail-head">
            What <b>{sel.title.slice(0, 60)}</b> produced at each stage
            <span className={`src-badge ${SOURCE_META[sel.source || "claude"].cls}`}>
              {SOURCE_META[sel.source || "claude"].label}
            </span>
          </div>
          <div className="pf-detail-grid">
            <div className="pf-out">
              <div className="pf-out-h"><MessageSquare size={13} /> Conversation</div>
              <div className="pf-out-b">{trace.msgs} messages · {relTime(sel.updatedAt)}{trace.firstUser ? ` · “${cleanSnippet(trace.firstUser, 80)}”` : ""}</div>
            </div>
            <div className={`pf-out ${done?.summarize ? "" : "empty"}`}>
              <div className="pf-out-h"><FileText size={13} /> Summary</div>
              <div className="pf-out-b">{trace.summary ? cleanSnippet(trace.summary, 280) : "Not summarized yet — open the chat and hit Summarize."}</div>
            </div>
            <div className={`pf-out ${done?.topics ? "" : "empty"}`}>
              <div className="pf-out-h"><Tag size={13} /> Topics extracted</div>
              <div className="pf-out-b">
                {trace.topics.length ? (
                  <div className="gp-tags">{trace.topics.map((t) => <span key={t} className="concept-tag">{t}</span>)}</div>
                ) : "No topics tagged yet."}
              </div>
            </div>
            <div className={`pf-out ${done?.kg ? "" : "empty"}`}>
              <div className="pf-out-h"><Network size={13} /> Knowledge-graph relations</div>
              <div className="pf-out-b">
                {trace.related.length ? (
                  <ul className="pf-rel">
                    {trace.related.slice(0, 6).map((r) => (
                      <li key={r.id}>
                        <button className="link-btn" onClick={() => onOpen(r.id)}>{r.title.slice(0, 42)}</button>
                        <span className="pf-rel-shared">{r.shared.slice(0, 3).join(", ")}{r.shared.length > 3 ? "…" : ""} <b>×{r.shared.length}</b></span>
                      </li>
                    ))}
                  </ul>
                ) : "Not linked to any other conversation yet."}
              </div>
            </div>
            <div className={`pf-out ${done?.stm ? "" : "empty"}`}>
              <div className="pf-out-h"><Clock size={13} /> Short-term memory</div>
              <div className="pf-out-b">
                {done?.stm
                  ? `Within the recent-activity window — contributes to STM (last touched ${relTime(sel.updatedAt)}).`
                  : `Aged out of the STM window (last touched ${relTime(sel.updatedAt)}); no longer in short-term memory.`}
              </div>
            </div>
            <div className={`pf-out ${done?.ltm ? "" : "empty"}`}>
              <div className="pf-out-h"><Brain size={13} /> Long-term memory</div>
              <div className="pf-out-b">
                {trace.memEntries.length
                  ? trace.memEntries.map((m) => (
                      <div key={m.id} className="pf-ltm-item"><b>{m.subject}</b> — {cleanSnippet(m.body, 160)}</div>
                    ))
                  : "Not consolidated to long-term memory (not flagged memory-worthy)."}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="pf-legend">
        <span><i className="pf-leg-dot" /> Two lanes feed memory: <b>conversations</b> are summarized → topics → knowledge graph; <b>Gmail &amp; Calendar</b> sync into reminders/tasks. Both fold into short- &amp; long-term memory (daily). Click STM/LTM/Reminders/Gmail to see their contents.</span>
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal pf-detail-modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <button className="btn-secondary pf-back" onClick={() => setDetail(null)}>
                <ArrowLeft size={14} /> Back
              </button>
              <h3>
                {detail === "stm" && <><Clock size={16} /> Short-term memory</>}
                {detail === "ltm" && <><Brain size={16} /> Long-term memory</>}
                {detail === "reminders" && <><Bell size={16} /> Reminders &amp; tasks</>}
              </h3>
              <button className="icon-btn" onClick={() => setDetail(null)} aria-label="close"><X size={18} /></button>
            </header>
            <section className="settings-section pf-detail-body">
              {(detail === "stm" || detail === "ltm") && (
                <div
                  className="pf-md"
                  dangerouslySetInnerHTML={{ __html: md((detail === "stm" ? memoryFiles.stm : memoryFiles.ltm) || "_(empty)_") }}
                />
              )}
              {detail === "reminders" && (() => {
                const list = reminders.slice().sort((a, b) => Number(a.done) - Number(b.done) || a.dueAt - b.dueAt);
                return list.length === 0 ? (
                  <div className="lookup-muted">No reminders yet.</div>
                ) : (
                  <ul className="pf-rem-list">
                    {list.map((r) => (
                      <li key={r.id} className={r.done ? "done" : ""}>
                        <input type="checkbox" checked={r.done} onChange={() => toggleReminder(r.id)} />
                        <span className="pf-rem-text">{r.text}</span>
                        <span className="pf-rem-due">{new Date(r.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{r.source && r.source !== "manual" ? ` · ${r.source}` : ""}</span>
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { claude: "🟠", chatgpt: "🟢", gemini: "🔵" };
const SOURCE_COLOR: Record<string, string> = { claude: "#D97757", chatgpt: "#10a37f", gemini: "#4a8df0" };
const SOURCE_META: Record<string, { label: string; cls: string }> = {
  claude: { label: "Claude", cls: "src-claude" },
  chatgpt: { label: "GPT", cls: "src-gpt" },
  gemini: { label: "Gemini", cls: "src-gemini" },
};

function byDayMap(chats: Conversation[]) {
  const m = new Map<number, Conversation[]>();
  for (const c of chats) {
    const k = sod(c.updatedAt);
    (m.get(k) ?? m.set(k, []).get(k)!).push(c);
  }
  return m;
}

// ---- Calendar (month grid) ------------------------------------------------

function CalendarView({ chats, onOpen }: { chats: Conversation[]; onOpen: (id: string) => void }) {
  const { reminders, toggleReminder, addReminder, activeProfile } = useStore();
  const [off, setOff] = useState(0);
  const [addDay, setAddDay] = useState<number | null>(null); // start-of-day ts being added to
  const [aText, setAText] = useState("");
  const [aTime, setATime] = useState("09:00");
  const [aRepeat, setARepeat] = useState<Repeat>("none");
  const [kind, setKind] = useState<"all" | "events" | "tasks">("all");
  const openAdd = (k: number) => {
    setAddDay(k);
    setAText("");
    setATime("09:00");
    setARepeat("none");
  };
  const submitAdd = () => {
    if (!aText.trim() || addDay == null || !activeProfile) return;
    const due = new Date(addDay);
    const [h, m] = aTime.split(":");
    due.setHours(Number(h) || 9, Number(m) || 0, 0, 0);
    addReminder({ profileId: activeProfile.id, text: aText.trim(), dueAt: due.getTime(), done: false, repeat: aRepeat });
    setAddDay(null);
  };
  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + off);
  const year = base.getFullYear();
  const month = base.getMonth();
  const startW = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const map = useMemo(() => byDayMap(chats), [chats]);
  const remByDay = useMemo(() => {
    // expand recurring reminders into all their occurrences this month
    const monthStart = new Date(year, month, 1).getTime();
    const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
    const m = new Map<number, typeof reminders>();
    for (const r of reminders) {
      if (kind === "events" && r.source !== "gcal") continue;
      if (kind === "tasks" && r.source === "gcal") continue;
      for (const t of occurrencesInRange(r, monthStart, monthEnd)) {
        const k = sod(t);
        (m.get(k) ?? m.set(k, []).get(k)!).push(r);
      }
    }
    return m;
  }, [reminders, year, month, kind]);
  const today = sod(Date.now());

  const cells: (number | null)[] = [];
  for (let i = 0; i < startW; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);

  return (
    <div className="cal">
      <div className="view-nav">
        <button className="icon-btn" onClick={() => setOff((o) => o - 1)}>
          <ChevronLeft size={18} />
        </button>
        <h3>{base.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h3>
        <button className="icon-btn" onClick={() => setOff((o) => o + 1)}>
          <ChevronRight size={18} />
        </button>
        <div className="cal-kind-filter">
          {(["all", "events", "tasks"] as const).map((k) => (
            <button key={k} className={`src-chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
              {k === "all" ? "All" : k === "events" ? "📅 Events" : "✓ Tasks"}
            </button>
          ))}
        </div>
      </div>
      <div className="cal-grid cal-dow">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <div key={d} className="cal-dow-cell">{d}</div>
        ))}
      </div>
      <div className="cal-grid cal-body">
        {cells.map((d, i) => {
          if (d === null) return <div key={i} className="cal-cell empty" />;
          const k = new Date(year, month, d).setHours(0, 0, 0, 0);
          const list = map.get(k) || [];
          return (
            <div key={i} className={`cal-cell ${k === today ? "today" : ""}`}>
              <div className="cal-cell-head">
                <span className="cal-day">{d}</span>
                <button className="cal-add" title="Add task / reminder" onClick={() => openAdd(k)}>
                  <Plus size={13} />
                </button>
              </div>
              <div className="cal-chips">
                {list.slice(0, 3).map((c) => (
                  <button
                    key={c.id}
                    className="cal-chip"
                    style={{ borderLeftColor: colorFor(c.concepts[0] || c.title) }}
                    title={c.title}
                    onClick={() => onOpen(c.id)}
                  >
                    {c.title}
                  </button>
                ))}
                {list.length > 3 && <span className="cal-more">+{list.length - 3} more</span>}
                {(remByDay.get(k) || []).map((r) => (
                  <button
                    key={r.id}
                    className={`cal-rem ${r.done ? "done" : ""}`}
                    title={`Reminder: ${r.text}`}
                    onClick={() => toggleReminder(r.id)}
                  >
                    🔔 {r.text}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {addDay != null && (
        <div className="modal-backdrop" onClick={() => setAddDay(null)}>
          <div className="modal cal-add-modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h3>
                <CalIcon size={16} /> Add for {new Date(addDay).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
              </h3>
              <button className="icon-btn" onClick={() => setAddDay(null)} aria-label="close"><X size={18} /></button>
            </header>
            <section className="settings-section">
              <label className="field">
                <span>Task / reminder</span>
                <input
                  autoFocus
                  value={aText}
                  onChange={(e) => setAText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submitAdd()}
                  placeholder="e.g. Pay rent, Dentist appointment…"
                />
              </label>
              <div className="cal-add-row">
                <label className="field">
                  <span>Time</span>
                  <input type="time" value={aTime} onChange={(e) => setATime(e.target.value)} />
                </label>
                <label className="field">
                  <span>Repeat</span>
                  <select value={aRepeat} onChange={(e) => setARepeat(e.target.value as Repeat)}>
                    {(["none", "daily", "weekly", "monthly", "yearly"] as Repeat[]).map((r) => (
                      <option key={r} value={r}>{r === "none" ? "Doesn't repeat" : `Repeats ${r}`}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="editor-actions">
                <button className="btn-secondary" onClick={() => setAddDay(null)}>Cancel</button>
                <button className="new-chat-btn" style={{ margin: 0 }} disabled={!aText.trim()} onClick={submitAdd}>
                  <Plus size={15} /> Add
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Weekly (recent week agenda) ------------------------------------------

function WeeklyView({ chats, onOpen }: { chats: Conversation[]; onOpen: (id: string) => void }) {
  const { reminders, toggleReminder, addReminder, activeProfile } = useStore();
  const [off, setOff] = useState(0);
  const [kind, setKind] = useState<"all" | "events" | "tasks">("all");
  const [addDay, setAddDay] = useState<number | null>(null);
  const [aText, setAText] = useState("");
  const [aTime, setATime] = useState("09:00");
  const [aRepeat, setARepeat] = useState<Repeat>("none");
  const weekStart = sow(Date.now()) + off * 7 * DAY;
  const map = useMemo(() => byDayMap(chats), [chats]);
  const remByDay = useMemo(() => {
    const m = new Map<number, typeof reminders>();
    for (const r of reminders) {
      if (kind === "events" && r.source !== "gcal") continue;
      if (kind === "tasks" && r.source === "gcal") continue;
      for (const t of occurrencesInRange(r, weekStart, weekStart + 7 * DAY - 1)) {
        const k = sod(t);
        (m.get(k) ?? m.set(k, []).get(k)!).push(r);
      }
    }
    return m;
  }, [reminders, weekStart, kind]);
  const today = sod(Date.now());
  const days = Array.from({ length: 7 }, (_, i) => weekStart + i * DAY);
  const label =
    off === 0
      ? "This week"
      : `${new Date(weekStart).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(weekStart + 6 * DAY).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  const openAdd = (k: number) => { setAddDay(k); setAText(""); setATime("09:00"); setARepeat("none"); };
  const submitAdd = () => {
    if (!aText.trim() || addDay == null || !activeProfile) return;
    const due = new Date(addDay);
    const [h, m] = aTime.split(":");
    due.setHours(Number(h) || 9, Number(m) || 0, 0, 0);
    addReminder({ profileId: activeProfile.id, text: aText.trim(), dueAt: due.getTime(), done: false, repeat: aRepeat });
    setAddDay(null);
  };

  return (
    <div className="week">
      <div className="view-nav">
        <button className="icon-btn" onClick={() => setOff((o) => o - 1)}>
          <ChevronLeft size={18} />
        </button>
        <h3>{label}</h3>
        <button className="icon-btn" onClick={() => setOff((o) => o + 1)}>
          <ChevronRight size={18} />
        </button>
        <div className="cal-kind-filter">
          {(["all", "events", "tasks"] as const).map((k) => (
            <button key={k} className={`src-chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
              {k === "all" ? "All" : k === "events" ? "📅 Events" : "✓ Tasks"}
            </button>
          ))}
        </div>
      </div>
      <div className="week-grid">
        {days.map((d) => {
          const list = (map.get(d) || []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
          const rem = remByDay.get(d) || [];
          return (
            <div key={d} className={`week-col ${d === today ? "today" : ""}`}>
              <div className="week-col-head">
                <span>{new Date(d).toLocaleDateString(undefined, { weekday: "short" })}</span>
                <strong>{new Date(d).getDate()}</strong>
                <button className="cal-add" title="Add task / reminder" onClick={() => openAdd(d)}>
                  <Plus size={12} />
                </button>
              </div>
              <div className="week-col-body">
                {rem.map((r) => (
                  <button
                    key={r.id}
                    className={`cal-rem ${r.done ? "done" : ""}`}
                    title={r.text}
                    onClick={() => toggleReminder(r.id)}
                  >
                    {r.source === "gcal" || r.source === "gmail" ? r.text : `🔔 ${r.text}`}
                  </button>
                ))}
                {list.map((c) => (
                  <button
                    key={c.id}
                    className="week-card"
                    style={{ borderTopColor: colorFor(c.concepts[0] || c.title) }}
                    onClick={() => onOpen(c.id)}
                  >
                    <span className="week-card-title">{c.title}</span>
                    <span className="week-card-meta">{c.messages.length} msgs</span>
                  </button>
                ))}
                {list.length === 0 && rem.length === 0 && <div className="week-empty">·</div>}
              </div>
            </div>
          );
        })}
      </div>

      {addDay != null && (
        <div className="modal-backdrop" onClick={() => setAddDay(null)}>
          <div className="modal cal-add-modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h3><CalIcon size={16} /> Add for {new Date(addDay).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</h3>
              <button className="icon-btn" onClick={() => setAddDay(null)} aria-label="close"><X size={18} /></button>
            </header>
            <section className="settings-section">
              <label className="field">
                <span>Task / reminder</span>
                <input autoFocus value={aText} onChange={(e) => setAText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitAdd()} placeholder="e.g. Pay rent, Dentist…" />
              </label>
              <div className="cal-add-row">
                <label className="field"><span>Time</span><input type="time" value={aTime} onChange={(e) => setATime(e.target.value)} /></label>
                <label className="field">
                  <span>Repeat</span>
                  <select value={aRepeat} onChange={(e) => setARepeat(e.target.value as Repeat)}>
                    {(["none", "daily", "weekly", "monthly", "yearly"] as Repeat[]).map((r) => (
                      <option key={r} value={r}>{r === "none" ? "Doesn't repeat" : `Repeats ${r}`}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="editor-actions">
                <button className="btn-secondary" onClick={() => setAddDay(null)}>Cancel</button>
                <button className="new-chat-btn" style={{ margin: 0 }} disabled={!aText.trim()} onClick={submitAdd}>
                  <Plus size={15} /> Add
                </button>
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Interactive force graph (pan / zoom / drag) --------------------------

interface GNode { id: string; label: string; color: string; r: number; sub?: string; time?: number; weight?: number }
interface GEdge { a: string; b: string; w: number }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function ForceGraph({
  nodes,
  edges,
  onSelect,
  hint,
  overlay,
  activeId,
  clusterOf,
  clusterLabels,
  selectedCluster,
  onSelectCluster,
  onContextMenu,
  zoomIds,
  zoomNonce,
}: {
  nodes: GNode[];
  edges: GEdge[];
  onSelect: (id: string) => void;
  hint: string;
  overlay?: React.ReactNode;
  activeId?: string | null;
  clusterOf?: Record<string, number>;
  clusterLabels?: Record<number, string>;
  selectedCluster?: number | null;
  onSelectCluster?: (c: number | null) => void;
  onContextMenu?: (nodeId: string, clusterId: number, x: number, y: number) => void;
  zoomIds?: string[] | null;
  zoomNonce?: number;
}) {
  const W = 820;
  const H = 540;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const posRef = useRef(pos);
  posRef.current = pos;
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [hover, setHover] = useState<string | null>(null);
  const [scrub, setScrub] = useState(1); // timeline position 0..1
  const [timeOn, setTimeOn] = useState(false); // is the temporal fade active
  const [spread, setSpread] = useState(1.2); // force-layout spread factor
  const [zoomed, setZoomed] = useState(false); // drilled into a single cluster
  const [hoveredCluster, setHoveredCluster] = useState<number | null>(null);
  // drag state: either a pan or a node move
  const drag = useRef<
    | { pan: true; startVB: { x: number; y: number }; startView: typeof view; startClient: { x: number; y: number } }
    | { id: string; offx: number; offy: number; startClient: { x: number; y: number } }
    | null
  >(null);

  const buildLayout = (factor: number) => {
    const m = forceLayout(nodes.map((n) => ({ id: n.id })), edges, W, H, 320, factor);
    const o: Record<string, { x: number; y: number }> = {};
    m.forEach((v, k) => (o[k] = { x: v.x, y: v.y }));
    return o;
  };

  const sig = nodes.map((n) => n.id).join(",") + "|" + edges.length;
  useEffect(() => {
    setSpread(1.2);
    setPos(buildLayout(1.2));
    setView({ x: 0, y: 0, k: 1 });
    setTimeOn(false);
    setScrub(1);
    setZoomed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const clientToVB = (cx: number, cy: number) => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const m = svg.getScreenCTM();
    if (!m) return { x: cx, y: cy };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const toGraph = (cx: number, cy: number) => {
    const v = viewRef.current;
    const vb = clientToVB(cx, cy);
    return { x: (vb.x - v.x) / v.k, y: (vb.y - v.y) / v.k };
  };

  // wheel zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = viewRef.current;
      const vb = clientToVB(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const k2 = clamp(v.k * factor, 0.4, 4);
      setView({
        x: vb.x - (vb.x - v.x) * (k2 / v.k),
        y: vb.y - (vb.y - v.y) * (k2 / v.k),
        k: k2,
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return; // right-click → context menu, not pan
    if ((e.target as Element).closest(".gnode")) return; // node handles its own
    drag.current = {
      pan: true,
      startVB: clientToVB(e.clientX, e.clientY),
      startView: { ...viewRef.current },
      startClient: { x: e.clientX, y: e.clientY },
    };
    svgRef.current!.setPointerCapture(e.pointerId);
  };
  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button === 2) return; // right-click → context menu, not drag/select
    e.stopPropagation();
    const g = toGraph(e.clientX, e.clientY);
    const p = posRef.current[id] || g;
    drag.current = {
      id,
      offx: p.x - g.x,
      offy: p.y - g.y,
      startClient: { x: e.clientX, y: e.clientY },
    };
    svgRef.current!.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if ("pan" in d) {
      const vb = clientToVB(e.clientX, e.clientY);
      setView({
        x: d.startView.x + (vb.x - d.startVB.x),
        y: d.startView.y + (vb.y - d.startVB.y),
        k: d.startView.k,
      });
    } else {
      const g = toGraph(e.clientX, e.clientY);
      setPos((prev) => ({ ...prev, [d.id]: { x: g.x + d.offx, y: g.y + d.offy } }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    try {
      svgRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (d && !("pan" in d)) {
      const dist = Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y);
      if (dist < 5) onSelect(d.id); // treat as a click, not a drag
    } else if (d && "pan" in d) {
      const dist = Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y);
      if (dist < 5) {
        onSelectCluster?.(null); // background click clears cluster selection
        setZoomed(false);
      }
    }
  };

  const byId = useMemo(
    () => Object.fromEntries(nodes.map((n) => [n.id, n])) as Record<string, GNode>,
    [nodes],
  );
  // adjacency for neighbor-focus highlighting
  const adj = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    for (const n of nodes) m[n.id] = new Set();
    for (const e of edges) {
      m[e.a]?.add(e.b);
      m[e.b]?.add(e.a);
    }
    return m;
  }, [nodes, edges]);

  // cluster membership → hull groups (clusters with 2+ members get a halo)
  const clusterGroups = useMemo(() => {
    if (!clusterOf) return [] as { c: number; ids: string[] }[];
    const g: Record<number, string[]> = {};
    for (const n of nodes) {
      const c = clusterOf[n.id];
      if (c == null) continue;
      (g[c] ??= []).push(n.id);
    }
    return Object.entries(g)
      .map(([c, ids]) => ({ c: Number(c), ids }))
      .filter((x) => x.ids.length >= 2);
  }, [clusterOf, nodes]);

  // the "focus" node drives highlighting: hovered, else the open preview node
  const focus = hover || activeId || null;
  const inFocus = (id: string) =>
    !focus || id === focus || !!adj[focus]?.has(id);

  const applyZoom = (factor: number) => {
    const v = viewRef.current;
    const cx = W / 2;
    const cy = H / 2;
    const k2 = clamp(v.k * factor, 0.4, 4);
    setView({
      x: cx - (cx - v.x) * (k2 / v.k),
      y: cy - (cy - v.y) * (k2 / v.k),
      k: k2,
    });
  };

  // Frame all nodes within the viewport (pan + zoom to fit).
  const fitToView = (p: Record<string, { x: number; y: number }> = posRef.current) => {
    const ids = Object.keys(p);
    if (!ids.length) return;
    const xs = ids.map((i) => p[i].x);
    const ys = ids.map((i) => p[i].y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 60;
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const k = clamp(Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh), 0.4, 4);
    setView({
      x: W / 2 - (k * (minX + maxX)) / 2,
      y: H / 2 - (k * (minY + maxY)) / 2,
      k,
    });
  };

  // Re-run the force-directed layout with more separation, then fit.
  const spreadMore = () => {
    const f = clamp(spread * 1.3, 1, 3.4);
    setSpread(f);
    const o = buildLayout(f);
    setPos(o);
    fitToView(o);
  };

  // Zoom into one cluster: re-spread ONLY its nodes across the canvas (so a
  // tightly-packed cluster fans out instead of overlapping), then frame them.
  useEffect(() => {
    if (!zoomNonce || !zoomIds || !zoomIds.length) return;
    const ids = zoomIds.filter((id) => byId[id]);
    if (!ids.length) return;
    let next = posRef.current;
    if (ids.length >= 2) {
      const idset = new Set(ids);
      const subEdges = edges.filter((e) => idset.has(e.a) && idset.has(e.b));
      const m = forceLayout(ids.map((id) => ({ id })), subEdges, W, H, 320, 1.5);
      next = { ...posRef.current };
      m.forEach((v, k) => (next[k] = { x: v.x, y: v.y }));
      setPos(next);
    }
    const sub: Record<string, { x: number; y: number }> = {};
    for (const id of ids) if (next[id]) sub[id] = next[id];
    if (Object.keys(sub).length) fitToView(sub);
    setZoomed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomNonce]);

  // Graph-Commons style: labels stay on; only hide them when zoomed far out.
  const labelFor = (n: GNode, h: boolean) => h || view.k > 0.6 || n.r >= 14;

  // cluster centroids (for placing the on-map cluster name labels)
  const activeCluster = hoveredCluster != null ? hoveredCluster : selectedCluster ?? null;
  const centroids = clusterGroups
    .map(({ c, ids }) => {
      const pts = ids.map((id) => pos[id]).filter(Boolean) as { x: number; y: number }[];
      if (pts.length < 2) return null;
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
      const top = Math.min(...pts.map((p) => p.y));
      return { c, ids, cx, cy, top, name: clusterLabels?.[c] || `Cluster ${c + 1}` };
    })
    .filter(Boolean) as { c: number; ids: string[]; cx: number; cy: number; top: number; name: string }[];

  // --- timeline: fade nodes by how far their date is from the scrubber ---
  const times = nodes
    .map((n) => n.time)
    .filter((t): t is number => typeof t === "number");
  const minT = times.length ? Math.min(...times) : 0;
  const maxT = times.length ? Math.max(...times) : 0;
  const hasTime = times.length > 1 && maxT > minT;
  const scrubTime = minT + scrub * (maxT - minT);
  const sigma = (maxT - minT) * 0.13 || 1;
  const tOpacity = (t?: number) =>
    !timeOn || t == null
      ? 1
      : Math.max(0.08, Math.exp(-Math.pow((t - scrubTime) / sigma, 2)));
  const fmtDate = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  // activity histogram: sum each node's "amount of conversation" per time bucket
  const BUCKETS = 30;
  const buckets = new Array(BUCKETS).fill(0);
  if (hasTime) {
    for (const n of nodes) {
      if (n.time == null) continue;
      const f = (n.time - minT) / (maxT - minT);
      const idx = Math.min(BUCKETS - 1, Math.max(0, Math.floor(f * BUCKETS)));
      buckets[idx] += n.weight || 1;
    }
  }
  const maxBucket = Math.max(1, ...buckets);
  const activeBucket = timeOn ? Math.min(BUCKETS - 1, Math.floor(scrub * BUCKETS)) : -1;

  return (
    <div className="graph-wrap">
      <div className="graph-canvas">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="graph-svg"
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onBgPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {/* soft cluster region (always an ellipse) — hovered/selected cluster only */}
          {activeCluster != null && (() => {
            const grp = clusterGroups.find((g) => g.c === activeCluster);
            if (!grp) return null;
            const pts = grp.ids.map((id) => pos[id]).filter(Boolean) as { x: number; y: number }[];
            if (pts.length < 2) return null;
            const maxR = Math.max(...grp.ids.map((id) => byId[id]?.r || 8));
            const xs = pts.map((p) => p.x);
            const ys = pts.map((p) => p.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const cx = (minX + maxX) / 2;
            const cy = (minY + maxY) / 2;
            const pad = maxR + 24;
            const rx = (maxX - minX) / 2 + pad;
            const ry = (maxY - minY) / 2 + pad;
            const col = clusterColor(activeCluster);
            return (
              <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={col} stroke={col}
                fillOpacity={0.1} strokeOpacity={0.4} strokeWidth={1.4 / view.k} pointerEvents="none" />
            );
          })()}
          {/* straight edges (Graph-Commons style) */}
          {edges.map((e, i) => {
            const a = pos[e.a];
            const b = pos[e.b];
            if (!a || !b) return null;
            const na = byId[e.a];
            const nb = byId[e.b];
            const lit = focus ? e.a === focus || e.b === focus : false;
            const tEdge = Math.min(tOpacity(na?.time), tOpacity(nb?.time));
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={lit ? "var(--accent)" : "var(--text-faint)"}
                strokeWidth={(lit ? Math.min(e.w, 4) * 0.5 + 0.5 : Math.min(e.w, 4) * 0.4) / view.k}
                strokeLinecap="round"
                opacity={(focus ? (lit ? 0.85 : 0.05) : 0.22) * tEdge}
              />
            );
          })}
          {/* nodes — flat circles coloured by cluster */}
          {nodes.map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            const h = hover === n.id;
            const active = n.id === activeId;
            const dim = focus ? !inFocus(n.id) : false;
            const inActive = clusterOf != null && activeCluster != null && clusterOf[n.id] === activeCluster;
            const cdim = activeCluster != null && clusterOf != null && !inActive;
            const inSel = clusterOf != null && selectedCluster != null && clusterOf[n.id] === selectedCluster;
            const shrink = zoomed && inSel ? 0.6 : 1; // smaller when drilled into a cluster
            const r = n.r * shrink * (h || active ? 1.25 : 1);
            return (
              <g
                key={n.id}
                className="gnode"
                opacity={(dim || cdim ? 0.18 : 1) * tOpacity(n.time)}
                onPointerDown={(e) => onNodePointerDown(e, n.id)}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onContextMenu={(e) => {
                  if (!onContextMenu) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const c = clusterOf?.[n.id] ?? -1;
                  if (c >= 0) onSelectCluster?.(c);
                  onContextMenu(n.id, c, e.clientX, e.clientY);
                }}
              >
                {(active || h) && (
                  <circle cx={p.x} cy={p.y} r={r + 4 / view.k} fill="none" stroke={n.color} strokeWidth={2 / view.k} opacity={0.55} />
                )}
                <circle
                  cx={p.x} cy={p.y} r={r}
                  fill={n.color}
                  stroke="var(--bg)"
                  strokeWidth={1 / view.k}
                />
                {labelFor(n, h) && (
                  <text
                    x={p.x} y={p.y + r + 9 / view.k}
                    textAnchor="middle"
                    className="graph-label"
                    fontSize={(h ? 10 : 8.5) / view.k}
                  >
                    {n.label}
                  </text>
                )}
                {h && n.sub && (
                  <text
                    x={p.x} y={p.y + r + 20 / view.k}
                    textAnchor="middle"
                    className="graph-sub"
                    fontSize={8 / view.k}
                  >
                    {n.sub}
                  </text>
                )}
              </g>
            );
          })}
          {/* on-map cluster name labels (hover highlights the cluster) */}
          {centroids.map(({ c, ids, cx, top, name }) => {
            const lit = activeCluster === c;
            return (
              <g
                key={`clabel-${c}`}
                className="gclabel"
                transform={`translate(${cx}, ${top - 14 / view.k})`}
                onMouseEnter={() => setHoveredCluster(c)}
                onMouseLeave={() => setHoveredCluster((v) => (v === c ? null : v))}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectCluster?.(selectedCluster === c ? null : c);
                }}
                onContextMenu={(e) => {
                  if (!onContextMenu) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onSelectCluster?.(c);
                  onContextMenu(ids[0], c, e.clientX, e.clientY);
                }}
              >
                <text
                  textAnchor="middle"
                  className="graph-clabel"
                  fontSize={(lit ? 13 : 11) / view.k}
                  fill={clusterColor(c)}
                  stroke="var(--bg)"
                  strokeWidth={3 / view.k}
                  paintOrder="stroke"
                >
                  {name} · {ids.length}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph-controls">
        <button onClick={() => applyZoom(1.25)} title="Zoom in">+</button>
        <button onClick={() => applyZoom(1 / 1.25)} title="Zoom out">−</button>
        <button onClick={() => fitToView()} title="Fit to screen">
          <Maximize2 size={15} />
        </button>
        <button onClick={spreadMore} title="Spread nodes (re-run layout)">
          <Shuffle size={15} />
        </button>
        <button onClick={() => setView({ x: 0, y: 0, k: 1 })} title="Reset view">⤾</button>
      </div>
      <div className="graph-zoom-badge">{Math.round(view.k * 100)}%</div>
      {overlay}
      </div>

      {hasTime && (
        <div className="graph-timeline">
          <button
            className="gt-step"
            title="Earlier"
            onClick={() => {
              setTimeOn(true);
              setScrub((s) => clamp(s - 0.08, 0, 1));
            }}
          >
            ◀
          </button>
          <span className="gt-end">{fmtDate(minT)}</span>
          <div className="gt-track">
            <div className="gt-hist">
              {buckets.map((v, i) => (
                <div
                  key={i}
                  className="gt-bar"
                  data-active={i === activeBucket}
                  style={{ height: `${v ? Math.max(8, (v / maxBucket) * 100) : 0}%` }}
                  title={`${fmtDate(minT + ((i + 0.5) / BUCKETS) * (maxT - minT))} · ${v} msgs`}
                  onClick={() => {
                    setTimeOn(true);
                    setScrub((i + 0.5) / BUCKETS);
                  }}
                />
              ))}
            </div>
            <input
              type="range"
              min="0"
              max="1000"
              value={Math.round(scrub * 1000)}
              onChange={(e) => {
                setTimeOn(true);
                setScrub(Number(e.target.value) / 1000);
              }}
            />
          </div>
          <span className="gt-end">{fmtDate(maxT)}</span>
          <button
            className="gt-step"
            title="Later"
            onClick={() => {
              setTimeOn(true);
              setScrub((s) => clamp(s + 0.08, 0, 1));
            }}
          >
            ▶
          </button>
          <span className="gt-now">
            {timeOn ? `📅 ${fmtDate(scrubTime)}` : "All times"}
          </span>
          {timeOn && (
            <button className="gt-clear" onClick={() => setTimeOn(false)}>
              clear
            </button>
          )}
        </div>
      )}

      <div className="graph-hint">{hint}</div>
    </div>
  );
}

// ---- Preview panels (peek before opening) ---------------------------------

function ChatPreview({
  chat,
  onOpen,
  onClose,
}: {
  chat: Conversation;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { notes, memory } = useStore();
  const summary =
    chat.summary ||
    memory.find((m) => m.conversationId === chat.id)?.body ||
    notes.find((n) => n.conversationId === chat.id)?.body ||
    null;
  const firstUser = chat.messages.find((m) => m.role === "user")?.content || "";
  const lastAsst =
    [...chat.messages].reverse().find((m) => m.role === "assistant")?.content || "";

  return (
    <aside className="graph-preview" onPointerDown={(e) => e.stopPropagation()}>
      <div className="gp-head">
        <span className="gp-title">{chat.title}</span>
        <button className="icon-btn" onClick={onClose} aria-label="close">
          <X size={16} />
        </button>
      </div>
      <div className="gp-meta">
        {chat.messages.length} messages · {relTime(chat.updatedAt)}
      </div>
      {chat.concepts.length > 0 && (
        <div className="gp-tags">
          {chat.concepts.map((c) => (
            <span key={c} className="concept-tag">{c}</span>
          ))}
        </div>
      )}
      {summary ? (
        <div className="gp-section">
          <div className="gp-label">Summary</div>
          <p>{cleanSnippet(summary, 320)}</p>
        </div>
      ) : (
        <div className="gp-section">
          <div className="gp-label">Snippets</div>
          {firstUser && <p className="gp-snip"><b>You:</b> {cleanSnippet(firstUser)}</p>}
          {lastAsst && <p className="gp-snip"><b>AI:</b> {cleanSnippet(lastAsst)}</p>}
        </div>
      )}
      <button className="new-chat-btn gp-open" onClick={onOpen}>
        Open conversation <ArrowRight size={15} />
      </button>
    </aside>
  );
}

function TopicPreview({
  topic,
  chats,
  onOpen,
  onClose,
}: {
  topic: string;
  chats: Conversation[];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const related = chats
    .filter((c) => c.concepts.includes(topic))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <aside className="graph-preview" onPointerDown={(e) => e.stopPropagation()}>
      <div className="gp-head">
        <span className="gp-title">
          <span className="hash">#</span>
          {topic}
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="close">
          <X size={16} />
        </button>
      </div>
      <div className="gp-meta">
        {related.length} session{related.length > 1 ? "s" : ""} · click one to open
      </div>
      <div className="gp-list">
        {related.map((c) => {
          const snip =
            c.summary ||
            [...c.messages].reverse().find((m) => m.role === "assistant")?.content ||
            c.messages[0]?.content ||
            "";
          return (
            <button key={c.id} className="gp-item" onClick={() => onOpen(c.id)}>
              <div className="gp-item-top">
                <span className="gp-item-title">{c.title}</span>
                <span className="chat-item-time">{relTime(c.updatedAt)}</span>
              </div>
              <div className="gp-snip">{c.summary ? "✦ " : ""}{cleanSnippet(snip, 90)}</div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ---- Knowledge graph (conversations as nodes) -----------------------------

function GraphModeToggle({ mode, setMode }: { mode: "graph" | "table"; setMode: (m: "graph" | "table") => void }) {
  return (
    <div className="gview-toggle">
      <button className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>Graph</button>
      <button className={mode === "table" ? "active" : ""} onClick={() => setMode("table")}>Table</button>
    </div>
  );
}

// Grouped, collapsible, sortable + filterable table used by both graph tabs.
interface ClusterCol<T> {
  key: string;
  label: string;
  num?: boolean;
  sortVal: (r: T) => number | string;
  cell: (r: T) => React.ReactNode;
  agg?: (rows: T[]) => React.ReactNode;
}
function ClusterTable<T>({
  rows,
  clusterOf,
  clusterName,
  clusterColorOf,
  columns,
  rowKey,
  onRowClick,
}: {
  rows: T[];
  clusterOf: (r: T) => number;
  clusterName: (c: number) => string;
  clusterColorOf: (c: number) => string;
  columns: ClusterCol<T>[];
  rowKey: (r: T) => string;
  onRowClick: (r: T) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: columns[0].key, dir: "asc" });
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  const col = columns.find((c) => c.key === sort.key) || columns[0];
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const filtered = q
      ? rows.filter((r) => columns.some((c) => String(c.sortVal(r)).toLowerCase().includes(q)))
      : rows;
    const m = new Map<number, T[]>();
    for (const r of filtered) {
      const c = clusterOf(r);
      (m.get(c) || m.set(c, []).get(c)!).push(r);
    }
    const cmp = (a: T, b: T) => {
      const va = col.sortVal(a);
      const vb = col.sortVal(b);
      const d = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? d : -d;
    };
    const arr = [...m.entries()].map(([c, items]) => ({ c, items: items.slice().sort(cmp) }));
    arr.sort((g1, g2) => {
      if (col.num) {
        const s1 = g1.items.reduce((s, r) => s + Number(col.sortVal(r)), 0);
        const s2 = g2.items.reduce((s, r) => s + Number(col.sortVal(r)), 0);
        return sort.dir === "asc" ? s1 - s2 : s2 - s1;
      }
      return g2.items.length - g1.items.length;
    });
    return arr;
  }, [rows, q, sort, col, columns, clusterOf]);

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.c));
  const toggle = (c: number) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(c) ? n.delete(c) : n.add(c);
      return n;
    });
  const sortBy = (k: string) =>
    setSort((s) =>
      s.key === k
        ? { key: k, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key: k, dir: columns.find((c) => c.key === k)?.num ? "desc" : "asc" },
    );

  return (
    <div className="gtable">
      <div className="gtable-bar">
        <input className="gtable-filter" placeholder="filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button
          className="link-btn"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.c)))}
        >
          {allCollapsed ? "expand all" : "collapse all"}
        </button>
        <span className="gtable-count">{groups.length} clusters</span>
      </div>
      <div className="gtable-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`gt-sortable ${c.num ? "gt-num" : ""}`}
                  onClick={() => sortBy(c.key)}
                >
                  {c.label}
                  {sort.key === c.key && <span className="gt-arrow">{sort.dir === "asc" ? " ▲" : " ▼"}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(({ c, items }) => {
              const col0 = collapsed.has(c);
              return (
                <Fragment key={c}>
                  <tr className="gt-cluster" onClick={() => toggle(c)}>
                    <td className="gt-name">
                      <span className="gt-caret">{col0 ? "▸" : "▾"}</span>
                      <span className="gt-dot" style={{ background: clusterColorOf(c) }} />
                      <b>{clusterName(c)}</b>
                      <span className="gt-cl-count">{items.length}</span>
                    </td>
                    {columns.slice(1).map((cc) => (
                      <td key={cc.key} className={cc.num ? "gt-num" : ""}>
                        {cc.agg ? cc.agg(items) : ""}
                      </td>
                    ))}
                  </tr>
                  {!col0 &&
                    items.map((r) => (
                      <tr key={rowKey(r)} className="gt-child" onClick={() => onRowClick(r)}>
                        {columns.map((cc, ci) => (
                          <td key={cc.key} className={`${cc.num ? "gt-num" : ""} ${ci === 0 ? "gt-indent" : ""}`}>
                            {cc.cell(r)}
                          </td>
                        ))}
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ClusterMenuState { x: number; y: number; nodeIds: string[]; chatIds: string[]; label: string }

function ClusterMenu({
  menu,
  busy,
  onZoom,
  onContinue,
  onClose,
}: {
  menu: ClusterMenuState | null;
  busy: boolean;
  onZoom: () => void;
  onContinue: () => void;
  onClose: () => void;
}) {
  if (!menu) return null;
  return (
    <>
      <div
        className="cluster-menu-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="cluster-menu" style={{ left: menu.x, top: menu.y }}>
        <div className="cm-head">{menu.label}</div>
        <button className="cm-item" onClick={onZoom}>
          <ZoomIn size={14} />
          <span>Zoom into cluster</span>
          <span className="cm-count">{menu.chatIds.length} chat{menu.chatIds.length > 1 ? "s" : ""}</span>
        </button>
        <button className="cm-item" disabled={busy || !menu.chatIds.length} onClick={onContinue}>
          {busy ? <Loader size={14} className="spin" /> : <MessageSquarePlus size={14} />}
          <span>Continue conversation</span>
          <span className="cm-count">{menu.chatIds.length} chat{menu.chatIds.length > 1 ? "s" : ""}</span>
        </button>
      </div>
    </>
  );
}

// Panel listing the distinct conversations inside a zoomed cluster.
function ClusterConvosPanel({
  label,
  convos,
  onOpen,
  onContinue,
  busy,
  onClose,
}: {
  label: string;
  convos: Conversation[];
  onOpen: (id: string) => void;
  onContinue: () => void;
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <aside className="graph-preview" onPointerDown={(e) => e.stopPropagation()}>
      <div className="gp-head">
        <span className="gp-title">{label}</span>
        <button className="icon-btn" onClick={onClose} aria-label="close">
          <X size={16} />
        </button>
      </div>
      <div className="gp-meta">
        {convos.length} distinct conversation{convos.length > 1 ? "s" : ""} in this cluster · click one to open
      </div>
      <div className="gp-list">
        {convos.map((c) => {
          const snip =
            c.summary ||
            [...c.messages].reverse().find((m) => m.role === "assistant")?.content ||
            c.messages[0]?.content ||
            "";
          return (
            <button key={c.id} className="gp-item" onClick={() => onOpen(c.id)}>
              <div className="gp-item-top">
                <span className="gp-item-title">{c.title}</span>
                <span className="chat-item-time">{relTime(c.updatedAt)}</span>
              </div>
              <div className="gp-snip">{c.summary ? "✦ " : ""}{cleanSnippet(snip, 90)}</div>
            </button>
          );
        })}
      </div>
      <button className="new-chat-btn gp-open" disabled={busy} onClick={onContinue}>
        {busy ? <Loader size={15} className="spin" /> : <MessageSquarePlus size={15} />}
        Continue conversation
      </button>
    </aside>
  );
}

// Knowledge graph as a topic-rooted explorer: pick a topic, see its related
// topics + conversations, then click onward to walk the graph.
function ChatGraphView({ chats, onOpen }: { chats: Conversation[]; onOpen: (id: string) => void }) {
  const [root, setRoot] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);

  const data = useMemo(() => {
    const live = chats.filter((c) => !c.deleted && c.messages.length > 0);
    const topicChats = new Map<string, Conversation[]>();
    const co = new Map<string, number>(); // "a|b" → shared-conversation count
    for (const c of live) {
      const cs = [...new Set(c.concepts)];
      for (const k of cs) (topicChats.get(k) ?? topicChats.set(k, []).get(k)!).push(c);
      for (let i = 0; i < cs.length; i++)
        for (let j = i + 1; j < cs.length; j++) {
          const key = cs[i] < cs[j] ? `${cs[i]}|${cs[j]}` : `${cs[j]}|${cs[i]}`;
          co.set(key, (co.get(key) || 0) + 1);
        }
    }
    const adj = new Map<string, { topic: string; w: number }[]>();
    for (const [key, w] of co) {
      const [a, b] = key.split("|");
      (adj.get(a) ?? adj.set(a, []).get(a)!).push({ topic: b, w });
      (adj.get(b) ?? adj.set(b, []).get(b)!).push({ topic: a, w });
    }
    const topics = [...topicChats.keys()]
      .map((t) => ({ topic: t, sessions: topicChats.get(t)!.length, links: adj.get(t)?.length || 0 }))
      .sort((a, b) => b.sessions - a.sessions || a.topic.localeCompare(b.topic));
    return { topicChats, adj, topics };
  }, [chats]);

  const goTo = (t: string) => {
    setHistory((h) => (root ? [...h, root] : h));
    setRoot(t);
    setPreviewId(null);
  };
  const jumpTo = (i: number) => {
    const t = history[i];
    setHistory(history.slice(0, i));
    setRoot(t);
    setPreviewId(null);
  };
  const back = () =>
    setHistory((h) => {
      const n = [...h];
      const prev = n.pop();
      setRoot(prev ?? null);
      setPreviewId(null);
      return n;
    });
  const reset = () => {
    setRoot(null);
    setHistory([]);
    setPreviewId(null);
  };

  const graph = useMemo(() => {
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];
    if (!root) return { nodes, edges };
    const rootChats = (data.topicChats.get(root) || []).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    nodes.push({
      id: `t:${root}`,
      label: root,
      color: colorFor(root),
      r: 24,
      sub: `${rootChats.length} session${rootChats.length === 1 ? "" : "s"}`,
    });
    for (const { topic, w } of (data.adj.get(root) || []).slice().sort((a, b) => b.w - a.w).slice(0, 12)) {
      nodes.push({
        id: `t:${topic}`,
        label: topic,
        color: colorFor(topic),
        r: 10 + Math.min(w, 8),
        sub: `${data.topicChats.get(topic)?.length || 0} sessions · ${w} shared`,
      });
      edges.push({ a: `t:${root}`, b: `t:${topic}`, w });
    }
    for (const c of rootChats.slice(0, 14)) {
      nodes.push({
        id: `c:${c.id}`,
        label: c.title.length > 18 ? c.title.slice(0, 16) + "…" : c.title,
        color: colorFor(c.concepts[0] || c.title),
        r: 5 + Math.min(c.messages.length, 10) * 0.5,
        time: c.updatedAt,
        weight: c.messages.length,
      });
      edges.push({ a: `t:${root}`, b: `c:${c.id}`, w: 1 });
    }
    return { nodes, edges };
  }, [root, data]);

  const onSelect = (id: string) => {
    if (id.startsWith("t:")) {
      const t = id.slice(2);
      if (t !== root) goTo(t);
    } else if (id.startsWith("c:")) {
      setPreviewId(id.slice(2));
    }
  };
  const preview = previewId ? chats.find((c) => c.id === previewId) || null : null;

  // --- topic picker (entry point) ---
  if (!root) {
    const q = query.trim().toLowerCase();
    const list = q ? data.topics.filter((t) => t.topic.toLowerCase().includes(q)) : data.topics;
    return (
      <div className="gview">
        <div className="kg-pick-head">
          <span>Pick a topic to explore its related topics &amp; conversations</span>
          <input className="gtable-filter" placeholder="filter topics…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="gtable">
          <div className="gtable-scroll">
            <table>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th className="gt-num">Sessions</th>
                  <th className="gt-num">Related</th>
                  <th className="gt-num"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => (
                  <tr key={t.topic} onClick={() => goTo(t.topic)} title="Explore this topic">
                    <td className="gt-name"><span className="gt-dot" style={{ background: colorFor(t.topic) }} />{t.topic}</td>
                    <td className="gt-num">{t.sessions}</td>
                    <td className="gt-num">{t.links}</td>
                    <td className="gt-num"><ArrowRight size={14} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // --- exploration view (rooted at `root`) ---
  return (
    <div className="gview">
      <div className="kg-crumbs">
        <button className="link-btn" onClick={reset}>Topics</button>
        {history.map((h, i) => (
          <span key={i} className="kg-crumb">
            <ChevronRight size={12} />
            <button className="link-btn" onClick={() => jumpTo(i)}>{h}</button>
          </span>
        ))}
        <ChevronRight size={12} />
        <span className="kg-current">#{root}</span>
        {history.length > 0 && (
          <button className="btn-secondary kg-back" onClick={back}>Back</button>
        )}
      </div>
      <ForceGraph
        nodes={graph.nodes}
        edges={graph.edges}
        onSelect={onSelect}
        activeId={preview ? `c:${preview.id}` : `t:${root}`}
        hint="Click a related topic to explore it · click a conversation to preview · drag / scroll to move."
        overlay={preview && <ChatPreview chat={preview} onOpen={() => onOpen(preview.id)} onClose={() => setPreviewId(null)} />}
      />
    </div>
  );
}

// ---- Topics (centrality-sized) --------------------------------------------

function TopicGraphView({ chats, onOpen }: { chats: Conversation[]; onOpen: (id: string) => void }) {
  const { continueCluster } = useStore();
  const [mode, setMode] = useState<"graph" | "table">("table");
  const [previewTopic, setPreviewTopic] = useState<string | null>(null);
  const [selectedCluster, setSelectedCluster] = useState<number | null>(null);
  const [menu, setMenu] = useState<ClusterMenuState | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<{ ids: string[]; nonce: number } | null>(null);
  const [panel, setPanel] = useState<{ chatIds: string[]; label: string } | null>(null);
  const data = useMemo(() => {
    const chatCount = new Map<string, number>();
    const msgCount = new Map<string, number>();
    const latest = new Map<string, Conversation>();
    const topicChats = new Map<string, Set<string>>(); // topic -> chat ids
    const co = new Map<string, number>();
    for (const c of chats) {
      const cs = [...new Set(c.concepts)];
      for (const k of cs) {
        chatCount.set(k, (chatCount.get(k) || 0) + 1);
        msgCount.set(k, (msgCount.get(k) || 0) + (c.messages?.length || 0));
        (topicChats.get(k) || topicChats.set(k, new Set()).get(k)!).add(c.id);
        const cur = latest.get(k);
        if (!cur || c.updatedAt > cur.updatedAt) latest.set(k, c);
      }
      for (let i = 0; i < cs.length; i++)
        for (let j = i + 1; j < cs.length; j++) {
          const key = cs[i] < cs[j] ? `${cs[i]}|${cs[j]}` : `${cs[j]}|${cs[i]}`;
          co.set(key, (co.get(key) || 0) + 1);
        }
    }
    const deg = new Map<string, number>();
    const edges: GEdge[] = [...co.entries()].map(([k, w]) => {
      const [a, b] = k.split("|");
      deg.set(a, (deg.get(a) || 0) + 1);
      deg.set(b, (deg.get(b) || 0) + 1);
      return { a, b, w };
    });
    const topics = [...chatCount.keys()];
    // cluster related topics together
    const clusterOf = clusterize(topics, edges);
    const members: Record<number, string[]> = {};
    for (const [id, c] of clusterOf) (members[c] ??= []).push(id);
    // name each cluster by its most-central member topic (most sessions)
    const clusterLabels: Record<number, string> = {};
    for (const [cl, ts] of Object.entries(members)) {
      const best = ts.slice().sort((a, b) => (chatCount.get(b) || 0) - (chatCount.get(a) || 0))[0];
      clusterLabels[Number(cl)] = best || `Cluster ${Number(cl) + 1}`;
    }
    const maxC = Math.max(1, ...[...chatCount.values()]);
    const nodes: GNode[] = topics.map((id) => {
      const cc = chatCount.get(id)!;
      const cl = clusterOf.get(id)!;
      const clustered = (members[cl]?.length || 0) >= 2;
      return {
        id,
        label: id,
        color: clustered ? clusterColor(cl) : colorFor(id),
        r: 8 + (cc / maxC) * 16, // size = centrality (sessions touching it)
        sub: `${cc} session${cc > 1 ? "s" : ""} · ${deg.get(id) || 0} links`,
        time: latest.get(id)?.updatedAt, // most recent session on this topic
        weight: msgCount.get(id) || cc, // amount of conversation on this topic
      };
    });
    // Centrality score: blended degree (connections) + reach (sessions), 0–100.
    const maxD = Math.max(1, ...[...deg.values()]);
    const table = topics
      .map((id) => {
        const sessions = chatCount.get(id)!;
        const links = deg.get(id) || 0;
        const centrality = Math.round((sessions / maxC) * 70 + (links / maxD) * 30);
        return { id, cluster: clusterOf.get(id)!, sessions, links, centrality };
      })
      .sort((a, b) => a.cluster - b.cluster || b.centrality - a.centrality || b.sessions - a.sessions);
    const clusterObj: Record<string, number> = Object.fromEntries(clusterOf);
    return { nodes, edges, latest, table, clusterOf: clusterObj, members, topicChats, clusterLabels };
  }, [chats]);

  const openLatest = (topic: string) => {
    const c = data.latest.get(topic);
    if (c) onOpen(c.id);
  };
  const openMenu = (nodeId: string, clusterId: number, x: number, y: number) => {
    const topics = clusterId >= 0 ? data.members[clusterId] || [] : [nodeId];
    const ids = new Set<string>();
    for (const t of topics) for (const id of data.topicChats.get(t) || []) ids.add(id);
    const label = `Cluster: ${topics.slice(0, 3).join(" · ")}`;
    setMenu({ x, y, nodeIds: topics, chatIds: [...ids], label });
  };
  const doZoom = () => {
    if (!menu) return;
    setZoom((z) => ({ ids: menu.nodeIds, nonce: (z?.nonce || 0) + 1 }));
    setPanel({ chatIds: menu.chatIds, label: menu.label });
    setMenu(null);
  };
  const continueWith = async (chatIds: string[], label: string) => {
    setBusy(true);
    try {
      const conv = await continueCluster(chatIds, label.replace(/^Cluster:\s*/, ""));
      setMenu(null);
      setPanel(null);
      onOpen(conv.id);
    } finally {
      setBusy(false);
    }
  };
  const doContinue = () => menu && continueWith(menu.chatIds, menu.label);
  const panelConvos = panel ? chats.filter((c) => panel.chatIds.includes(c.id)) : [];

  if (data.nodes.length === 0) {
    return (
      <div className="explore-empty">
        <p>
          No concepts yet. Load showcase data, or wait for the knowledge-graph
          phase to auto-tag your chats with concepts.
        </p>
      </div>
    );
  }

  return (
    <div className="gview">
      <GraphModeToggle mode={mode} setMode={setMode} />
      {mode === "graph" ? (
        <ForceGraph
          nodes={data.nodes}
          edges={data.edges}
          onSelect={setPreviewTopic}
          activeId={previewTopic}
          clusterOf={data.clusterOf}
          clusterLabels={data.clusterLabels}
          selectedCluster={selectedCluster}
          onSelectCluster={setSelectedCluster}
          onContextMenu={openMenu}
          zoomIds={zoom?.ids}
          zoomNonce={zoom?.nonce}
          hint="Hover a cluster label to highlight it · click to select · right-click → Zoom in / Continue conversation."
          overlay={
            <>
              {previewTopic && (
                <TopicPreview
                  topic={previewTopic}
                  chats={chats}
                  onOpen={onOpen}
                  onClose={() => setPreviewTopic(null)}
                />
              )}
              {panel && !previewTopic && (
                <ClusterConvosPanel
                  label={panel.label}
                  convos={panelConvos}
                  onOpen={onOpen}
                  onContinue={() => continueWith(panel.chatIds, panel.label)}
                  busy={busy}
                  onClose={() => setPanel(null)}
                />
              )}
            </>
          }
        />
      ) : (
        <ClusterTable
          rows={data.table}
          rowKey={(r) => r.id}
          clusterOf={(r) => r.cluster}
          clusterName={(c) => data.clusterLabels[c] || `Cluster ${c + 1}`}
          clusterColorOf={(c) => ((data.members[c]?.length || 0) >= 2 ? clusterColor(c) : "var(--text-faint)")}
          onRowClick={(r) => openLatest(r.id)}
          columns={[
            { key: "id", label: "Topic", sortVal: (r) => r.id, cell: (r) => r.id },
            { key: "sessions", label: "Sessions", num: true, sortVal: (r) => r.sessions, cell: (r) => r.sessions, agg: (rows) => rows.reduce((s, r) => s + r.sessions, 0) },
            { key: "links", label: "Links", num: true, sortVal: (r) => r.links, cell: (r) => r.links, agg: (rows) => rows.reduce((s, r) => s + r.links, 0) },
            {
              key: "centrality",
              label: "Centrality",
              num: true,
              sortVal: (r) => r.centrality,
              cell: (r) => {
                const col = (data.members[r.cluster]?.length || 0) >= 2 ? clusterColor(r.cluster) : colorFor(r.id);
                return (
                  <span className="gt-cent">
                    <span className="gt-bar"><span className="gt-bar-fill" style={{ width: `${r.centrality}%`, background: col }} /></span>
                    <b>{r.centrality}</b>
                  </span>
                );
              },
              agg: (rows) => Math.max(...rows.map((r) => r.centrality)),
            },
          ]}
        />
      )}
      <ClusterMenu menu={menu} busy={busy} onZoom={doZoom} onContinue={doContinue} onClose={() => setMenu(null)} />
    </div>
  );
}
