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
} from "lucide-react";
import { useStore } from "../store";
import { api } from "../services/api";
import { forceLayout, relTime, occurrencesInRange, md } from "../utils";
import type { Conversation, Repeat } from "../types";
import { ImportArchive } from "./ImportArchive";

function cleanSnippet(s: string, n = 150): string {
  return s.replace(/[#*`>_]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
}

export type ExploreTab = "calendar" | "weekly" | "graph" | "topics" | "pipeline";

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
          <TabBtn on={tab === "calendar"} onClick={() => onTabChange("calendar")} icon={<CalIcon size={15} />} label="Calendar" />
          <TabBtn on={tab === "weekly"} onClick={() => onTabChange("weekly")} icon={<CalendarRange size={15} />} label="This week" />
          <TabBtn on={tab === "graph"} onClick={() => onTabChange("graph")} icon={<Network size={15} />} label="Knowledge graph" />
          <TabBtn on={tab === "topics"} onClick={() => onTabChange("topics")} icon={<Flame size={15} />} label="Topics" />
          <TabBtn on={tab === "pipeline"} onClick={() => onTabChange("pipeline")} icon={<Workflow size={15} />} label="Pipeline" />
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
  const { memory, memoryFiles, notes, reminders, toggleReminder, activeProfile } = useStore();
  const [localSel, setLocalSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<null | "stm" | "ltm" | "reminders" | "gmail">(null);
  const [emails, setEmails] = useState<{ id: string; ts: number; from: string; subject: string; snippet: string; source: string }[]>([]);
  useEffect(() => {
    if (detail === "gmail" && activeProfile) api.listEmails(activeProfile.id).then((r) => setEmails(r.emails)).catch(() => {});
  }, [detail, activeProfile]);
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
    { key: "gmail", x: 8, y: 33, icon: <Mail size={17} />, label: "Gmail", value: emailTasks, sub: "email tasks", done: null, ext: true, nav: null as ExploreTab | null, dialog: "gmail" as const, tip: "" },
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
                {detail === "gmail" && <><Mail size={16} /> Email tasks &amp; digest</>}
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
              {detail === "gmail" && (() => {
                const digest = notes.find((n) => /Inbox digest/.test(n.title))?.body;
                const tasks = reminders.filter((r) => r.source === "gmail").sort((a, b) => Number(a.done) - Number(b.done) || a.dueAt - b.dueAt);
                return (
                  <>
                    {digest && <div className="pf-digest"><b>📥 Inbox digest</b><p>{digest}</p></div>}
                    <div className="pf-sec-h">Emails <span className="pf-count">{emails.length}</span></div>
                    {emails.length === 0 ? (
                      <div className="lookup-muted">No emails stored yet — run an email sync or import.</div>
                    ) : (
                      <ul className="pf-email-list">
                        {emails.map((e) => (
                          <li key={e.id}>
                            <div className="pf-email-top">
                              <span className="pf-email-subj">{e.subject || "(no subject)"}</span>
                              <span className="pf-rem-due">{e.ts ? new Date(e.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : ""}</span>
                            </div>
                            {e.from && <div className="pf-email-from">{e.from}</div>}
                            {e.snippet && <div className="pf-email-snip">{e.snippet}</div>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {tasks.length > 0 && (
                      <>
                        <div className="pf-sec-h">Extracted tasks <span className="pf-count">{tasks.length}</span></div>
                        <ul className="pf-rem-list">
                          {tasks.map((r) => (
                            <li key={r.id} className={r.done ? "done" : ""}>
                              <input type="checkbox" checked={r.done} onChange={() => toggleReminder(r.id)} />
                              <span className="pf-rem-text">{r.text}</span>
                              <span className="pf-rem-due">{new Date(r.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
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
