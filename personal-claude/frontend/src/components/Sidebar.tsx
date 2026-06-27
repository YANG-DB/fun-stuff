import { useMemo, useState } from "react";
import {
  MessageSquare,
  StickyNote,
  Bell,
  Plus,
  LogOut,
  Pin,
  Search,
  Settings,
  LayoutDashboard,
  Brain,
  CalendarPlus,
  BellRing,
  Trash2,
  RotateCcw,
  CheckSquare,
  Square,
  Maximize2,
  Minimize2,
  PanelLeftClose,
  X,
  ArrowRight,
  Workflow,
  EyeOff,
  Tag,
} from "lucide-react";
import { useStore } from "../store";
import { api } from "../services/api";
import { relTime, dueLabel, formatTokens, groupChatList, REPEAT_LABEL } from "../utils";
import type { GroupBy } from "../utils";
import type { Conversation, Repeat } from "../types";
import { ProfileSettings } from "./ProfileSettings";
import { downloadICS, googleCalUrl } from "../services/calendar";
import { enableReminderNotifications } from "./ReminderAlerts";

type Tab = "chats" | "notes" | "reminders" | "memory";

interface Props {
  activeConversationId: string | null;
  exploring: boolean;
  onSelectConversation: (id: string | null) => void;
  onExplore: () => void;
  inPipeline?: boolean;
  onShowInPipeline?: (id: string) => void;
  sidebarMode?: "normal" | "hidden" | "full";
  setSidebarMode?: (m: "normal" | "hidden" | "full") => void;
}

export function Sidebar({
  activeConversationId,
  exploring,
  onSelectConversation,
  onExplore,
  inPipeline,
  onShowInPipeline,
  sidebarMode,
  setSidebarMode,
}: Props) {
  const store = useStore();
  const { activeProfile } = store;
  const [tab, setTab] = useState<Tab>("chats");
  const [tableOpen, setTableOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("date");
  const [showSettings, setShowSettings] = useState(false);

  const profileId = activeProfile!.id;

  const dueCount = useMemo(
    () =>
      store.reminders.filter((r) => r.profileId === profileId && !r.done).length,
    [store.reminders, profileId],
  );

  const budgetPct = Math.min(
    100,
    Math.round((activeProfile!.spentUsd / activeProfile!.budgetUsd) * 100),
  );

  return (
    <aside className="sidebar">
      <div className="sb-profile">
        <span className="sb-avatar" aria-hidden>
          {activeProfile!.avatar}
        </span>
        <div className="sb-profile-text">
          <div className="sb-profile-name">{activeProfile!.name}</div>
          <div className="sb-profile-tag">
            {activeProfile!.google ? (
              <span className="sb-google" title={activeProfile!.google.email}>
                {activeProfile!.google.picture ? (
                  <img
                    src={activeProfile!.google.picture}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="sb-google-dot" />
                )}
                {activeProfile!.google.email}
              </span>
            ) : (
              activeProfile!.tagline
            )}
          </div>
        </div>
        <button
          className="icon-btn"
          title="Profile settings"
          onClick={() => setShowSettings(true)}
        >
          <Settings size={16} />
        </button>
        <button
          className="icon-btn"
          title="Switch profile"
          onClick={() => store.selectProfile(null)}
        >
          <LogOut size={16} />
        </button>
        {setSidebarMode && (
          <>
            <button
              className="icon-btn"
              title={sidebarMode === "full" ? "Restore panel" : "Expand panel full screen"}
              onClick={() => setSidebarMode(sidebarMode === "full" ? "normal" : "full")}
            >
              {sidebarMode === "full" ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              className="icon-btn"
              title="Hide panel"
              onClick={() => setSidebarMode("hidden")}
            >
              <PanelLeftClose size={16} />
            </button>
          </>
        )}
      </div>

      {showSettings && <ProfileSettings onClose={() => setShowSettings(false)} />}

      <div className="sb-budget" title="Per-profile spend, metered by the gateway">
        <div className="sb-budget-bar">
          <div
            className="sb-budget-fill"
            style={{ width: `${budgetPct}%` }}
            data-warn={budgetPct >= 80}
          />
        </div>
        <span className="sb-budget-label">
          ${activeProfile!.spentUsd.toFixed(2)} / ${activeProfile!.budgetUsd} this
          month
          <span className="sb-token-total" title="Total tokens used by this profile">
            · {formatTokens(activeProfile!.tokens ?? 0)} tokens
          </span>
        </span>
      </div>

      <div className="sb-top-actions">
        <button
          className="new-chat-btn"
          onClick={async () => {
            const c = await store.createConversation(activeProfile!.defaultModel);
            onSelectConversation(c.id);
            setTab("chats");
          }}
        >
          <Plus size={16} /> New chat
        </button>
        <button
          className={`explore-btn ${exploring ? "active" : ""}`}
          title="Explore your chats"
          onClick={onExplore}
        >
          <LayoutDashboard size={16} /> Explore
        </button>
      </div>

      <nav className="sb-tabs">
        <TabBtn
          active={tab === "chats"}
          onClick={() => setTab("chats")}
          icon={<MessageSquare size={15} />}
          label="Chats"
        />
        <TabBtn
          active={tab === "notes"}
          onClick={() => setTab("notes")}
          icon={<StickyNote size={15} />}
          label="Notes"
        />
        <TabBtn
          active={tab === "reminders"}
          onClick={() => setTab("reminders")}
          icon={<Bell size={15} />}
          label="Reminders"
          badge={dueCount || undefined}
        />
        <TabBtn
          active={tab === "memory"}
          onClick={() => setTab("memory")}
          icon={<Brain size={15} />}
          label="Memory"
        />
      </nav>

      {tab === "chats" && (
        <>
          <div className="sb-search">
            <Search size={14} />
            <input
              placeholder="Search chats…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="sb-groupby">
            <span>Group by</span>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            >
              <option value="date">Date</option>
              <option value="subject">Subject (A–Z)</option>
              <option value="topic">Topic</option>
              <option value="length">Length</option>
            </select>
            <button
              className="sb-expand-btn"
              title="Expand to full table view"
              onClick={() => setTableOpen(true)}
            >
              <Maximize2 size={14} /> Table
            </button>
          </div>
        </>
      )}
      {tableOpen && (
        <ChatTableModal
          profileId={profileId}
          activeConversationId={activeConversationId}
          onSelect={(id) => {
            setTableOpen(false);
            onSelectConversation(id);
          }}
          onClose={() => setTableOpen(false)}
        />
      )}

      <div className="sb-list">
        {tab === "chats" && (
          <ChatList
            profileId={profileId}
            query={query}
            groupBy={groupBy}
            activeConversationId={activeConversationId}
            onSelect={onSelectConversation}
            onShowInPipeline={inPipeline ? onShowInPipeline : undefined}
          />
        )}
        {tab === "notes" && (
          <NotesList profileId={profileId} onOpen={onSelectConversation} />
        )}
        {tab === "reminders" && <RemindersList profileId={profileId} onOpen={onSelectConversation} />}
        {tab === "memory" && (
          <>
            <MemoryFiles />
            <MemoryList onOpen={onSelectConversation} />
          </>
        )}
      </div>
    </aside>
  );
}

function TabBtn(props: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      className={`sb-tab ${props.active ? "active" : ""}`}
      onClick={props.onClick}
    >
      {props.icon}
      <span>{props.label}</span>
      {props.badge ? <span className="tab-badge">{props.badge}</span> : null}
    </button>
  );
}

// --- Chats -----------------------------------------------------------------

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  claude: { label: "Claude", cls: "src-claude" },
  chatgpt: { label: "GPT", cls: "src-gpt" },
  gemini: { label: "Gemini", cls: "src-gemini" },
};

function ChatRow({
  c,
  active,
  highlight,
  selectMode,
  selected,
  onToggleSelect,
  onSelect,
  onSetDeleted,
  onShowInPipeline,
}: {
  c: Conversation;
  active: boolean;
  highlight?: string;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onSelect: (id: string) => void;
  onSetDeleted: (id: string, deleted: boolean) => void;
  onShowInPipeline?: (id: string) => void;
}) {
  const last = c.messages[c.messages.length - 1];
  const summary = c.summary || highlight;
  const src = SOURCE_META[c.source || "claude"];
  return (
    <div
      className={`chat-item ${active ? "active" : ""} ${c.deleted ? "is-deleted" : ""} ${selectMode ? "selectable" : ""}`}
      onClick={() => (selectMode ? onToggleSelect(c.id) : onSelect(c.id))}
    >
      {selectMode && (
        <span className="chat-check">
          {selected ? <CheckSquare size={16} /> : <Square size={16} />}
        </span>
      )}
      <div className="chat-item-body">
        <div className="chat-item-top">
          <span className="chat-item-title">
            {c.pinned && <Pin size={11} className="pin-ico" />}
            {c.deleted && <Trash2 size={11} className="del-ico" />}
            {c.title}
          </span>
          <span className="chat-item-time">{relTime(c.updatedAt)}</span>
        </div>
        {summary ? (
          <div className="chat-item-preview is-summary" title={summary}>
            <span className="sum-mark">✦</span>
            {summary.replace(/[#*`]/g, "").slice(0, 90)}
          </div>
        ) : (
          last && (
            <div className="chat-item-preview">
              {last.role === "assistant" ? "↩ " : ""}
              {last.content.replace(/[#*`]/g, "").slice(0, 60)}
            </div>
          )
        )}
        <div className="chat-item-tags">
          {src && <span className={`src-badge ${src.cls}`}>{src.label}</span>}
          {c.concepts.slice(0, 3).map((k) => (
            <span key={k} className="concept-tag">
              {k}
            </span>
          ))}
          {!!c.tokens && (
            <span className="token-tag" title="Tokens used in this session">
              ▦ {formatTokens(c.tokens)}
            </span>
          )}
        </div>
      </div>
      {!selectMode && (
        <div className="chat-row-acts">
          {onShowInPipeline && (
            <button
              className="chat-row-act"
              title="Show in pipeline"
              onClick={(e) => {
                e.stopPropagation();
                onShowInPipeline(c.id);
              }}
            >
              <Workflow size={13} />
            </button>
          )}
          <button
            className="chat-row-act"
            title={c.deleted ? "Restore" : "Delete (hide)"}
            onClick={(e) => {
              e.stopPropagation();
              onSetDeleted(c.id, !c.deleted);
            }}
          >
            {c.deleted ? <RotateCcw size={13} /> : <Trash2 size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}

function ChatList({
  profileId,
  query,
  groupBy,
  activeConversationId,
  onSelect,
  onShowInPipeline,
}: {
  profileId: string;
  query: string;
  groupBy: GroupBy;
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onShowInPipeline?: (id: string) => void;
}) {
  const { conversations, notes, memory, setConversationDeleted, bulkSetDeleted, reload } = useStore();
  const [source, setSource] = useState<"all" | "claude" | "chatgpt" | "gemini">("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tagging, setTagging] = useState(false);

  // Highlight fallback for conversations whose summary column isn't populated yet
  // (e.g. imported before summaries were persisted): use a note/memory body.
  const highlightOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const mm of memory) if (mm.conversationId && !m[mm.conversationId]) m[mm.conversationId] = mm.body;
    for (const n of notes) if (n.conversationId && !m[n.conversationId]) m[n.conversationId] = n.body;
    return m;
  }, [notes, memory]);

  const mine = useMemo(
    () => conversations.filter((c) => c.profileId === profileId),
    [conversations, profileId],
  );
  const sourceCounts = useMemo(() => {
    const m: Record<string, number> = { all: 0, claude: 0, chatgpt: 0, gemini: 0 };
    for (const c of mine) {
      if (c.deleted) continue;
      m.all++;
      m[c.source || "claude"] = (m[c.source || "claude"] || 0) + 1;
    }
    return m;
  }, [mine]);
  const deletedCount = useMemo(() => mine.filter((c) => c.deleted).length, [mine]);
  const emptyCount = useMemo(() => mine.filter((c) => !c.deleted && c.messages.length === 0).length, [mine]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mine
      .filter((c) => (showDeleted ? true : !c.deleted))
      .filter((c) => (hideEmpty ? c.messages.length > 0 : true))
      .filter((c) => source === "all" || (c.source || "claude") === source)
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.summary || "").toLowerCase().includes(q) ||
          c.concepts.some((k) => k.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [mine, query, source, showDeleted, hideEmpty]);

  const autoTag = async () => {
    setTagging(true);
    try {
      await api.autoTagQuick(profileId);
      await reload();
    } finally {
      setTagging(false);
    }
  };

  const groups = useMemo(() => groupChatList(items, groupBy), [items, groupBy]);

  const toggleSelect = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const exitSelect = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const applyDelete = async (deleted: boolean) => {
    const ids = [...selected];
    if (ids.length) await bulkSetDeleted(ids, deleted);
    exitSelect();
  };

  const sources: { key: typeof source; label: string }[] = [
    { key: "all", label: "All" },
    { key: "claude", label: "Claude" },
    { key: "chatgpt", label: "GPT" },
    { key: "gemini", label: "Gemini" },
  ];

  return (
    <>
      <div className="sb-filter">
        <div className="sb-srcfilter">
          {sources.map((s) => (
            <button
              key={s.key}
              className={`src-chip ${source === s.key ? "active" : ""}`}
              onClick={() => setSource(s.key)}
              disabled={s.key !== "all" && !sourceCounts[s.key]}
            >
              {s.label} {!!sourceCounts[s.key] && <b>{sourceCounts[s.key]}</b>}
            </button>
          ))}
        </div>
        <div className="sb-filter-row">
          <button
            className={`sb-toggle ${hideEmpty ? "active" : ""}`}
            onClick={() => setHideEmpty((v) => !v)}
            title="Hide conversations with no messages"
          >
            <EyeOff size={12} /> {hideEmpty ? "Empty hidden" : "Show empty"}
            {!!emptyCount && <b>{emptyCount}</b>}
          </button>
          <button
            className={`sb-toggle ${showDeleted ? "active" : ""}`}
            onClick={() => setShowDeleted((v) => !v)}
            title="Show soft-deleted chats"
          >
            <Trash2 size={12} /> {showDeleted ? "Showing deleted" : "Show deleted"}
            {!!deletedCount && <b>{deletedCount}</b>}
          </button>
          <button
            className={`sb-toggle ${selectMode ? "active" : ""}`}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
          >
            <CheckSquare size={12} /> {selectMode ? "Cancel" : "Select"}
          </button>
          <button
            className="sb-toggle"
            onClick={autoTag}
            disabled={tagging}
            title="Tag short, simple, one-off question chats as “quick question”"
          >
            <Tag size={12} /> {tagging ? "Tagging…" : "Auto-tag Qs"}
          </button>
        </div>
        {selectMode && (
          <div className="sb-selbar">
            <span className="sb-selcount">{selected.size} selected</span>
            <button className="link-btn" onClick={() => setSelected(new Set(items.map((c) => c.id)))}>
              all ({items.length})
            </button>
            <button className="sb-del-btn" disabled={!selected.size} onClick={() => applyDelete(true)}>
              <Trash2 size={13} /> Delete
            </button>
            <button className="sb-restore-btn" disabled={!selected.size} onClick={() => applyDelete(false)}>
              <RotateCcw size={13} /> Restore
            </button>
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-hint">No chats match this filter.</div>
      ) : (
        groups.map((g) => (
          <div className="chat-group" key={g.key}>
            <div className="chat-group-head">
              <span className="chat-group-label">
                {groupBy === "topic" && <span className="hash">#</span>}
                {g.label}
              </span>
              {g.meta && <span className="chat-group-meta">{g.meta}</span>}
            </div>
            {g.chats.map((c) => (
              <ChatRow
                key={g.key + ":" + c.id}
                c={c}
                active={c.id === activeConversationId}
                highlight={highlightOf[c.id]}
                selectMode={selectMode}
                selected={selected.has(c.id)}
                onToggleSelect={toggleSelect}
                onSelect={onSelect}
                onSetDeleted={setConversationDeleted}
                onShowInPipeline={onShowInPipeline}
              />
            ))}
          </div>
        ))
      )}
    </>
  );
}

// --- Full-screen chat table (expanded "left bar") --------------------------

function ChatTableModal({
  profileId,
  activeConversationId,
  onSelect,
  onClose,
}: {
  profileId: string;
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const { conversations, notes, memory, setConversationDeleted, bulkSetDeleted } = useStore();
  const [source, setSource] = useState<"all" | "claude" | "chatgpt" | "gemini">("all");
  const [showDeleted, setShowDeleted] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"updated" | "title" | "source" | "length">("updated");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const highlightOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const mm of memory) if (mm.conversationId && !m[mm.conversationId]) m[mm.conversationId] = mm.body;
    for (const n of notes) if (n.conversationId && !m[n.conversationId]) m[n.conversationId] = n.body;
    return m;
  }, [notes, memory]);

  const mine = useMemo(() => conversations.filter((c) => c.profileId === profileId), [conversations, profileId]);
  const sourceCounts = useMemo(() => {
    const m: Record<string, number> = { all: 0, claude: 0, chatgpt: 0, gemini: 0 };
    for (const c of mine) {
      if (c.deleted) continue;
      m.all++;
      m[c.source || "claude"] = (m[c.source || "claude"] || 0) + 1;
    }
    return m;
  }, [mine]);
  const deletedCount = useMemo(() => mine.filter((c) => c.deleted).length, [mine]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = mine
      .filter((c) => (showDeleted ? true : !c.deleted))
      .filter((c) => source === "all" || (c.source || "claude") === source)
      .filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q) ||
          (c.summary || "").toLowerCase().includes(q) ||
          c.concepts.some((k) => k.toLowerCase().includes(q)),
      );
    out.sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title);
      if (sort === "source") return (a.source || "").localeCompare(b.source || "") || b.updatedAt - a.updatedAt;
      if (sort === "length") return b.messages.length - a.messages.length;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }, [mine, query, source, showDeleted, sort]);

  const allSelected = rows.length > 0 && rows.every((c) => selected.has(c.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const apply = async (deleted: boolean) => {
    const ids = [...selected];
    if (ids.length) await bulkSetDeleted(ids, deleted);
    setSelected(new Set());
  };

  const sources: { key: typeof source; label: string }[] = [
    { key: "all", label: "All" },
    { key: "claude", label: "Claude" },
    { key: "chatgpt", label: "GPT" },
    { key: "gemini", label: "Gemini" },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal chat-table-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3><MessageSquare size={17} /> All chats — {rows.length}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close"><X size={18} /></button>
        </header>

        <div className="ctm-toolbar">
          <div className="sb-search ctm-search">
            <Search size={14} />
            <input placeholder="Search chats…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className="sb-srcfilter">
            {sources.map((s) => (
              <button
                key={s.key}
                className={`src-chip ${source === s.key ? "active" : ""}`}
                onClick={() => setSource(s.key)}
                disabled={s.key !== "all" && !sourceCounts[s.key]}
              >
                {s.label} {!!sourceCounts[s.key] && <b>{sourceCounts[s.key]}</b>}
              </button>
            ))}
          </div>
          <button
            className={`sb-toggle ${showDeleted ? "active" : ""}`}
            onClick={() => setShowDeleted((v) => !v)}
          >
            <Trash2 size={12} /> {showDeleted ? "Showing deleted" : "Show deleted"}
            {!!deletedCount && <b>{deletedCount}</b>}
          </button>
        </div>

        {!!selected.size && (
          <div className="ctm-selbar">
            <span className="sb-selcount">{selected.size} selected</span>
            <button className="sb-del-btn" onClick={() => apply(true)}><Trash2 size={13} /> Delete</button>
            <button className="sb-restore-btn" onClick={() => apply(false)}><RotateCcw size={13} /> Restore</button>
          </div>
        )}

        <div className="ctm-tablewrap">
          <table className="ctm-table">
            <thead>
              <tr>
                <th className="ctm-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((c) => c.id)) : new Set())}
                  />
                </th>
                <th onClick={() => setSort("title")} className="ctm-sortable">Title</th>
                <th onClick={() => setSort("source")} className="ctm-sortable">Source</th>
                <th>Summary</th>
                <th>Topics</th>
                <th onClick={() => setSort("length")} className="ctm-sortable ctm-num">Msgs</th>
                <th onClick={() => setSort("updated")} className="ctm-sortable ctm-num">Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const src = SOURCE_META[c.source || "claude"];
                const summary = c.summary || highlightOf[c.id] || "";
                return (
                  <tr
                    key={c.id}
                    className={`${c.id === activeConversationId ? "active" : ""} ${c.deleted ? "is-deleted" : ""}`}
                  >
                    <td className="ctm-check">
                      <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                    </td>
                    <td className="ctm-title" onClick={() => onSelect(c.id)}>
                      {c.deleted && <Trash2 size={11} className="del-ico" />}
                      {c.title}
                    </td>
                    <td><span className={`src-badge ${src.cls}`}>{src.label}</span></td>
                    <td className="ctm-summary" title={summary}>{summary.replace(/[#*`]/g, "").slice(0, 160)}</td>
                    <td className="ctm-topics">
                      {c.concepts.slice(0, 4).map((k) => <span key={k} className="concept-tag">{k}</span>)}
                    </td>
                    <td className="ctm-num">{c.messages.length}</td>
                    <td className="ctm-num">{relTime(c.updatedAt)}</td>
                    <td className="ctm-actions">
                      <button title="Open" onClick={() => onSelect(c.id)}><ArrowRight size={14} /></button>
                      <button
                        title={c.deleted ? "Restore" : "Delete (hide)"}
                        onClick={() => setConversationDeleted(c.id, !c.deleted)}
                      >
                        {c.deleted ? <RotateCcw size={13} /> : <Trash2 size={13} />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <div className="empty-hint">No chats match this filter.</div>}
        </div>
      </div>
    </div>
  );
}

// --- Notes -----------------------------------------------------------------

function NotesList({
  profileId,
  onOpen,
}: {
  profileId: string;
  onOpen: (id: string) => void;
}) {
  const { notes, deleteNote } = useStore();
  const items = notes
    .filter((n) => n.profileId === profileId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  if (items.length === 0) {
    return (
      <div className="empty-hint">
        No notes yet. Save important bits from chats here.
      </div>
    );
  }

  return (
    <>
      {items.map((n) => (
        <div key={n.id} className="note-item">
          <div className="note-item-head">
            <span className="note-item-title">{n.title}</span>
            <span className="chat-item-time">{relTime(n.updatedAt)}</span>
          </div>
          <div className="note-item-body">
            {n.body.replace(/[#*`>-]/g, "").slice(0, 90)}
          </div>
          <div className="note-item-actions">
            {n.conversationId && (
              <button
                className="link-btn"
                onClick={() => onOpen(n.conversationId!)}
              >
                open chat
              </button>
            )}
            <button className="link-btn danger" onClick={() => deleteNote(n.id)}>
              delete
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

// --- Memory ----------------------------------------------------------------

function MemoryFiles() {
  const { memoryFiles, refreshStm, refreshLtm } = useStore();
  const [busy, setBusy] = useState<null | "stm" | "ltm">(null);
  const run = async (which: "stm" | "ltm") => {
    setBusy(which);
    try {
      await (which === "stm" ? refreshStm() : refreshLtm());
    } finally {
      setBusy(null);
    }
  };
  const cards: { kind: "stm" | "ltm"; label: string; action: string; content: string; updated: number }[] = [
    { kind: "stm", label: "🟢 Short-term memory", action: "Refresh", content: memoryFiles.stm, updated: memoryFiles.stmUpdated },
    { kind: "ltm", label: "🔵 Long-term memory", action: "Consolidate", content: memoryFiles.ltm, updated: memoryFiles.ltmUpdated },
  ];
  return (
    <div className="memfiles">
      {cards.map((c) => (
        <div key={c.kind} className="memfile">
          <div className="memfile-head">
            <span className="memfile-label">{c.label}</span>
            <button className="link-btn" disabled={busy !== null} onClick={() => run(c.kind)}>
              {busy === c.kind ? "working…" : c.action}
            </button>
          </div>
          <div className="memfile-time">
            {c.updated ? `updated ${relTime(c.updated)}` : "not built yet"}
          </div>
          {c.content && <div className="memfile-body">{c.content.slice(0, 500)}</div>}
        </div>
      ))}
    </div>
  );
}

function MemoryList({ onOpen }: { onOpen: (id: string) => void }) {
  const { memory, deleteMemory } = useStore();

  if (memory.length === 0) {
    return (
      <div className="empty-hint">
        Nothing memorized yet. Open a chat and hit <strong>Memorize</strong> to
        add its summary to this profile's memory.
      </div>
    );
  }

  return (
    <>
      {memory.map((m) => (
        <div key={m.id} className="note-item">
          <div className="note-item-head">
            <span className="note-item-title">{m.subject}</span>
            <span className="chat-item-time">{relTime(m.createdAt)}</span>
          </div>
          <div className="note-item-body">{m.body.slice(0, 120)}</div>
          <div className="note-item-actions">
            {m.conversationId && (
              <button className="link-btn" onClick={() => onOpen(m.conversationId!)}>
                open chat
              </button>
            )}
            <button className="link-btn danger" onClick={() => deleteMemory(m.id)}>
              forget
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

// --- Reminders -------------------------------------------------------------

function ymd(ts: number): string {
  const d = new Date(ts);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function RemindersList({ profileId, onOpen }: { profileId: string; onOpen: (id: string) => void }) {
  const { reminders, toggleReminder, deleteReminder, addReminder, seedConversation } = useStore();
  const discuss = async (r: { text: string; source?: string }) => {
    const label = r.source === "gcal" ? "📅 event" : "🔔 reminder";
    const body = `${label}: **${r.text}**\n\n_Let's work on this — what do you need?_`;
    const c = await seedConversation(r.text.slice(0, 60), body);
    onOpen(c.id);
  };
  const [text, setText] = useState("");
  const [date, setDate] = useState(ymd(Date.now() + 86_400_000)); // tomorrow
  const [time, setTime] = useState("09:00");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [kind, setKind] = useState<"all" | "events" | "tasks">("all");
  const [notif, setNotif] = useState<string>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  const mine = reminders.filter((r) => r.profileId === profileId);
  const counts = {
    all: mine.length,
    events: mine.filter((r) => r.source === "gcal").length,
    tasks: mine.filter((r) => r.source !== "gcal").length,
  };
  const items = mine
    .filter((r) => kind === "all" || (kind === "events" ? r.source === "gcal" : r.source !== "gcal"))
    .sort((a, b) => Number(a.done) - Number(b.done) || a.dueAt - b.dueAt);

  return (
    <>
      {notif !== "granted" && (
        <button
          className="enable-alerts"
          onClick={async () => {
            if (await enableReminderNotifications()) setNotif("granted");
          }}
        >
          <BellRing size={13} /> Enable pop-up alerts
        </button>
      )}

      <form
        className="reminder-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          const dueAt = new Date(`${date}T${time || "09:00"}`).getTime() || Date.now();
          addReminder({ profileId, text: text.trim(), dueAt, done: false, repeat });
          setText("");
        }}
      >
        <input
          placeholder="Add a task / event / reminder…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="reminder-add-row">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="reminder-add-row">
          <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)} title="Recurrence">
            {(["none", "daily", "weekly", "monthly", "yearly"] as Repeat[]).map((r) => (
              <option key={r} value={r}>{r === "none" ? "Doesn't repeat" : `Repeats ${r}`}</option>
            ))}
          </select>
          <button type="submit" className="icon-btn" title="Add">
            <Plus size={16} />
          </button>
        </div>
      </form>

      <div className="sb-srcfilter rem-filter">
        {([
          ["all", "All"],
          ["events", "📅 Events"],
          ["tasks", "✓ Tasks"],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            className={`src-chip ${kind === k ? "active" : ""}`}
            onClick={() => setKind(k)}
            title={k === "events" ? "Calendar events" : k === "tasks" ? "Reminders & email tasks" : "Everything"}
          >
            {label} {!!counts[k] && <b>{counts[k]}</b>}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="empty-hint">Nothing due. You're clear.</div>
      ) : (
        items.map((r) => {
          const due = dueLabel(r.dueAt);
          return (
            <div key={r.id} className={`reminder-item ${r.done ? "done" : ""}`}>
              <input
                type="checkbox"
                checked={r.done}
                onChange={() => toggleReminder(r.id)}
              />
              <div className="reminder-main">
                <span className="reminder-text">{r.text}</span>
                <span className="reminder-sub">
                  {new Date(r.dueAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                  {" "}
                  {new Date(r.dueAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                  {r.repeat && r.repeat !== "none" && (
                    <span className="reminder-repeat">🔁 {REPEAT_LABEL[r.repeat]}</span>
                  )}
                  {!r.done && (
                    <span className={`reminder-due ${due.overdue ? "overdue" : ""}`}>
                      · {due.text}
                    </span>
                  )}
                </span>
              </div>
              <div className="reminder-acts">
                <button
                  className="link-btn"
                  title="Discuss in a new conversation"
                  onClick={() => discuss(r)}
                >
                  <MessageSquare size={13} />
                </button>
                <button
                  className="link-btn"
                  title="Download .ics (add to any calendar)"
                  onClick={() => downloadICS(r)}
                >
                  <CalendarPlus size={13} />
                </button>
                <a
                  className="link-btn"
                  href={googleCalUrl(r)}
                  target="_blank"
                  rel="noreferrer"
                  title="Add to Google Calendar"
                >
                  G
                </a>
                <button
                  className="link-btn danger"
                  title="Delete"
                  onClick={() => deleteReminder(r.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
