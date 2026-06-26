import { useEffect, useMemo, useRef, useState } from "react";
import { Send, Sparkles, BookmarkPlus, X, ChevronDown, FileText, BellPlus, Brain, ArrowLeft, Plus, Search, Globe, ExternalLink, Loader, MessageSquare, Download, Printer, Braces } from "lucide-react";
import { useStore } from "../store";
import { exportConversation } from "../services/exportData";
import { MODELS } from "../types";
import type { ContextChip, Message, ModelId } from "../types";
import { md, relTime, formatTokens } from "../utils";
import { retrieveContext, streamChat } from "../services/chatService";
import { api } from "../services/api";

interface Props {
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  onBack?: () => void;
}

export function ChatView({ conversationId, onConversationCreated, onBack }: Props) {
  const store = useStore();
  const { activeProfile } = store;
  const conversation = store.conversations.find((c) => c.id === conversationId);

  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<ModelId>(
    conversation?.model ?? activeProfile!.defaultModel,
  );
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState<null | "sum" | "rem" | "mem">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sumPanel, setSumPanel] = useState(false);
  const [sumResult, setSumResult] = useState<{ subject: string; summary: string; topics: string[] } | null>(null);
  const [lookup, setLookup] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Existing summary: freshly generated → persisted column → imported note/memory.
  const existingSummary =
    sumResult?.summary ||
    conversation?.summary ||
    store.memory.find((m) => m.conversationId === conversation?.id)?.body ||
    store.notes.find((n) => n.conversationId === conversation?.id)?.body ||
    null;
  const [live, setLive] = useState<{ thinking: string; activity: { name: string; q?: string }[] }>(
    { thinking: "", activity: [] },
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const settings = {
    thinking: activeProfile?.settings?.thinking ?? false,
    effort: activeProfile?.settings?.effort ?? "high",
    webTools: activeProfile?.settings?.webTools ?? true,
    memory: activeProfile?.settings?.memory ?? false,
  };

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  }

  // Slash-commands typed in the composer (don't go to the model).
  async function handleCommand(cmd: string) {
    if (!activeProfile) return;
    const parts = cmd.slice(1).trim().split(/\s+/);
    const c = (parts[0] || "").toLowerCase();
    const arg = parts[1];
    const on = (x?: string) => x !== "off";
    const cur = { thinking: false, effort: "high", webTools: true, memory: false, ...(activeProfile.settings || {}) };
    const save = (patch: Record<string, unknown>) =>
      store.updateProfile(activeProfile.id, { settings: { ...cur, ...patch } as never });
    switch (c) {
      case "think":
        save({ thinking: on(arg) });
        flash(`Extended thinking ${on(arg) ? "on (adaptive)" : "off"}`);
        break;
      case "effort":
        if (["low", "medium", "high", "xhigh"].includes(arg)) {
          save({ effort: arg });
          flash(`Effort set to ${arg}`);
        } else flash("Usage: /effort low | medium | high | xhigh");
        break;
      case "web":
        save({ webTools: on(arg) });
        flash(`Web search/fetch ${on(arg) ? "on" : "off"}`);
        break;
      case "memory":
        save({ memory: on(arg) });
        flash(`Memory tool ${on(arg) ? "on" : "off"}`);
        break;
      case "context":
        try {
          const { content } = await api.getContext(activeProfile.id);
          flash(content ? `user_context (${content.length} chars):\n${content.slice(0, 500)}` : "No user_context set — add it in ⚙ Settings.");
        } catch {
          flash("Couldn't load user_context.");
        }
        break;
      case "reload-context":
        flash("user_context is re-read on every message — already live.");
        break;
      case "help":
        flash("/think on|off · /effort low|medium|high|xhigh · /web on|off · /memory on|off · /context · /reload-context");
        break;
      default:
        flash(`Unknown command: /${c} — try /help`);
    }
  }

  // Open the summary panel: show the existing summary if one exists, else
  // generate it now. From the panel the user can recreate/update it.
  function openSummarize() {
    if (!conversation) return;
    setSumPanel(true);
    if (!existingSummary) runSummarize();
  }

  async function runSummarize() {
    if (!conversation || !activeProfile || acting) return;
    const hadSummary = !!conversation.summary;
    setActing("sum");
    try {
      const res = await api.summarizeChat(activeProfile.id, conversation.id);
      setSumResult(res);
      if (!hadSummary) {
        // keep a Notes entry the first time so it's discoverable there too
        store.addNote({
          profileId: activeProfile.id,
          conversationId: conversation.id,
          title: res.subject,
          body: res.summary,
        });
      }
      store.reload(); // pick up the persisted summary + concepts on the conversation
      flash(
        `Summary ${hadSummary ? "updated" : "saved"} · tagged: ${res.topics.slice(0, 4).join(", ") || "no topics"}`,
      );
    } catch (e) {
      flash(`Summarize failed: ${(e as Error).message}`);
    } finally {
      setActing(null);
    }
  }

  async function memorize() {
    if (!conversation || !activeProfile || acting) return;
    setActing("mem");
    try {
      const { subject, topics } = await store.memorize(conversation.id);
      flash(
        `Memorized "${subject}"${topics.length ? ` · ${topics.slice(0, 3).join(", ")}` : ""}`,
      );
    } catch (e) {
      flash(`Memorize failed: ${(e as Error).message}`);
    } finally {
      setActing(null);
    }
  }

  async function autoReminder() {
    if (!conversation || !activeProfile || acting) return;
    setActing("rem");
    try {
      const { text, dueInDays } = await api.reminderFromChat(
        activeProfile.id,
        conversation.id,
      );
      store.addReminder({
        profileId: activeProfile.id,
        text,
        dueAt: Date.now() + dueInDays * 86_400_000,
        done: false,
        conversationId: conversation.id,
      });
      flash(`Reminder set (in ${dueInDays}d): ${text.slice(0, 48)}`);
    } catch (e) {
      flash(`Reminder failed: ${(e as Error).message}`);
    } finally {
      setActing(null);
    }
  }

  const messages = conversation?.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, sending]);

  // Reset the summary panel when switching conversations.
  useEffect(() => {
    setSumPanel(false);
    setSumResult(null);
  }, [conversationId]);

  // Auto-enrichment: as the user types, surface relevant past sessions as
  // removable chips (idea.md §14). Debounced lightly.
  useEffect(() => {
    if (!activeProfile) return;
    const id = setTimeout(() => {
      if (draft.trim().length < 4) {
        setChips([]);
        return;
      }
      const found = retrieveContext(
        draft,
        activeProfile.id,
        store.conversations,
        conversationId ?? "",
        store.notes,
        store.memory,
      );
      setChips((prev) => {
        // preserve kept/removed state across keystrokes
        return found.map(
          (f) => prev.find((p) => p.id === f.id) ?? f,
        );
      });
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, conversationId]);

  async function send() {
    const text = draft.trim();
    if (!text || sending || !activeProfile) return;

    if (text.startsWith("/")) {
      setDraft("");
      await handleCommand(text);
      return;
    }

    setSending(true);
    setLive({ thinking: "", activity: [] });
    let convId = conversationId;
    if (!convId) {
      const c = await store.createConversation(model);
      convId = c.id;
      onConversationCreated(c.id);
    }

    const keptChips = chips.filter((c) => c.kept);
    const userMsg: Message = {
      id: `m-${Math.random().toString(36).slice(2, 9)}`,
      role: "user",
      content: text,
      ts: Date.now(),
      contextUsed: keptChips.length ? keptChips : undefined,
    };
    setDraft("");
    setChips([]);
    await store.appendMessage(convId, userMsg);

    const assistantMsg: Message = {
      id: `m-${Math.random().toString(36).slice(2, 9)}`,
      role: "assistant",
      content: "",
      ts: Date.now(),
      model,
    };
    await store.appendMessage(convId, assistantMsg);

    let acc = "";
    let think = "";
    try {
      const history = [...messages, userMsg];
      for await (const ev of streamChat({
        profile: activeProfile,
        model,
        messages: history,
        contextChips: keptChips,
        conversationId: convId,
        assistantMessageId: assistantMsg.id,
      })) {
        if (ev.type === "text") {
          acc += ev.v;
          store.updateMessage(convId, assistantMsg.id, acc); // local-only during stream
        } else if (ev.type === "thinking") {
          think += ev.v;
          setLive((l) => ({ ...l, thinking: think }));
        } else if (ev.type === "tool") {
          setLive((l) => ({ ...l, activity: [...l.activity, { name: ev.name, q: ev.q }] }));
        } else if (ev.type === "sources") {
          acc +=
            "\n\n---\n**Sources**\n" +
            ev.items.map((i) => `- [${i.title}](${i.url})`).join("\n");
          store.updateMessage(convId, assistantMsg.id, acc);
        }
      }
    } catch (err) {
      acc = acc || `⚠️ Gateway error: ${(err as Error).message}`;
    } finally {
      await store.updateMessage(convId, assistantMsg.id, acc, true);
      store.reload();
      store.refreshStmSoon(); // keep short-term memory current with recent activity
      setSending(false);
    }
  }

  if (!conversation && messages.length === 0 && !conversationId) {
    return (
      <EmptyState
        name={activeProfile!.name}
        model={model}
        setModel={setModel}
        draft={draft}
        setDraft={setDraft}
        onSend={send}
        chips={chips}
        setChips={setChips}
        sending={sending}
      />
    );
  }

  return (
    <main className="chat">
      <header className="chat-header">
        {onBack && (
          <button className="back-btn" onClick={onBack} title="Back to Explore">
            <ArrowLeft size={16} /> Back
          </button>
        )}
        <div className="chat-title">{conversation?.title ?? "New chat"}</div>
        <div className="chat-header-right">
          {messages.length > 0 && (
            <>
              <button
                className="chat-action-btn"
                disabled={acting !== null}
                onClick={openSummarize}
                title={conversation?.summary ? "View / update this chat's summary" : "Summarize this chat → saves a summary and tags topics"}
              >
                <FileText size={14} />
                {acting === "sum" ? "Summarizing…" : existingSummary ? "Summary" : "Summarize"}
              </button>
              <button
                className="chat-action-btn"
                disabled={acting !== null}
                onClick={autoReminder}
                title="Extract a follow-up → adds a reminder"
              >
                <BellPlus size={14} />
                {acting === "rem" ? "Thinking…" : "Remind"}
              </button>
              <button
                className="chat-action-btn"
                disabled={acting !== null}
                onClick={memorize}
                title="Summarize and add to this profile's memory"
              >
                <Brain size={14} />
                {acting === "mem" ? "Memorizing…" : "Memorize"}
              </button>
              <div className="export-menu-wrap">
                <button
                  className="chat-action-btn"
                  onClick={() => setExportOpen((v) => !v)}
                  title="Export this conversation"
                >
                  <Download size={14} /> Export
                </button>
                {exportOpen && conversation && (
                  <>
                    <div className="export-menu-backdrop" onClick={() => setExportOpen(false)} />
                    <div className="export-menu">
                      <button onClick={() => { exportConversation(conversation, "md"); setExportOpen(false); }}>
                        <FileText size={13} /> Markdown
                      </button>
                      <button onClick={() => { exportConversation(conversation, "json"); setExportOpen(false); }}>
                        <Braces size={13} /> JSON
                      </button>
                      <button onClick={() => { exportConversation(conversation, "pdf"); setExportOpen(false); }}>
                        <Printer size={13} /> PDF
                      </button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          <span
            className="status-line"
            title="Chat settings — change with /think, /effort, /web, /memory"
          >
            🧠{settings.thinking ? " adaptive" : " off"} · ⚡{settings.effort}
            {settings.webTools ? " · 🔍" : ""}
            {settings.memory ? " · 🧩" : ""}
          </span>
          {!!conversation?.tokens && (
            <span className="token-pill" title="Tokens used in this session">
              ▦ {formatTokens(conversation.tokens)} tokens
            </span>
          )}
          <ModelSelector model={model} setModel={setModel} />
        </div>
      </header>
      {toast && <div className="chat-toast">{toast}</div>}

      {existingSummary && (
        <button
          className="chat-summary-banner"
          onClick={openSummarize}
          title={existingSummary.replace(/[#*`]/g, "")}
        >
          <FileText size={13} />
          <span className="csb-text">{existingSummary.replace(/[#*`]/g, "")}</span>
        </button>
      )}

      {sumPanel && (
        <div className="modal-backdrop" onClick={() => setSumPanel(false)}>
          <div className="modal summary-modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h3><FileText size={17} /> Conversation summary</h3>
              <button className="icon-btn" onClick={() => setSumPanel(false)} aria-label="close">
                <X size={18} />
              </button>
            </header>
            <section className="settings-section">
              {(sumResult?.subject) && <div className="sm-subject">{sumResult.subject}</div>}
              {acting === "sum" && !sumResult ? (
                <p className="sm-body sm-muted">Generating summary…</p>
              ) : existingSummary ? (
                <p className="sm-body">{existingSummary}</p>
              ) : (
                <p className="sm-body sm-muted">No summary yet.</p>
              )}
              {(sumResult?.topics?.length || conversation?.concepts.length) ? (
                <div className="gp-tags">
                  {(sumResult?.topics || conversation?.concepts || []).map((t) => (
                    <span key={t} className="concept-tag">{t}</span>
                  ))}
                </div>
              ) : null}
              <div className="editor-actions">
                <button className="btn-secondary" onClick={() => setSumPanel(false)}>Close</button>
                <button className="new-chat-btn" style={{ margin: 0 }} disabled={acting === "sum"} onClick={runSummarize}>
                  <Sparkles size={14} /> {acting === "sum" ? "Working…" : existingSummary ? "Recreate / update" : "Generate"}
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            onLookup={setLookup}
            onSaveNote={() => {
              store.addNote({
                profileId: activeProfile!.id,
                conversationId: conversation?.id,
                title: conversation?.title.slice(0, 40) ?? "Saved note",
                body: m.content,
              });
            }}
          />
        ))}
        {sending && <TypingDots />}
      </div>

      {lookup && (
        <WordLookup
          word={lookup}
          profileId={activeProfile!.id}
          onOpenConversation={(id) => {
            setLookup(null);
            onConversationCreated(id);
          }}
          onClose={() => setLookup(null)}
        />
      )}

      {(live.thinking || live.activity.length > 0) && (
        <div className="live-panel">
          {live.activity.map((a, i) => (
            <div key={i} className="live-tool">
              🔍 {a.name}
              {a.q ? `: ${a.q}` : ""}
            </div>
          ))}
          {live.thinking && (
            <details className="live-thinking" open>
              <summary>🧠 thinking</summary>
              <div className="live-thinking-body">{live.thinking}</div>
            </details>
          )}
        </div>
      )}

      <Composer
        draft={draft}
        setDraft={setDraft}
        onSend={send}
        chips={chips}
        setChips={setChips}
        sending={sending}
      />
    </main>
  );
}

function ModelSelector({
  model,
  setModel,
}: {
  model: ModelId;
  setModel: (m: ModelId) => void;
}) {
  return (
    <div className="model-select">
      <select value={model} onChange={(e) => setModel(e.target.value as ModelId)}>
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <ChevronDown size={14} />
    </div>
  );
}

function MessageBubble({
  message,
  onSaveNote,
  onLookup,
}: {
  message: Message;
  onSaveNote: () => void;
  onLookup?: (word: string) => void;
}) {
  const [saved, setSaved] = useState(false);
  const isUser = message.role === "user";
  return (
    <div className={`msg ${isUser ? "user" : "assistant"}`}>
      <div className="msg-role">
        {isUser ? "You" : MODELS.find((m) => m.id === message.model)?.label ?? "AI"}
        <span className="msg-time">{relTime(message.ts)}</span>
      </div>
      {message.contextUsed && message.contextUsed.length > 0 && (
        <div className="msg-context">
          <Sparkles size={11} /> used {message.contextUsed.length} past snippet
          {message.contextUsed.length > 1 ? "s" : ""}
        </div>
      )}
      <div
        className="msg-body"
        title={onLookup ? "Right-click a word to search context & web" : undefined}
        onContextMenu={
          onLookup
            ? (e) => {
                const w = wordAtEvent(e);
                if (w) {
                  e.preventDefault();
                  onLookup(w);
                }
              }
            : undefined
        }
        dangerouslySetInnerHTML={{ __html: md(message.content || "…") }}
      />
      {!isUser && message.content && (
        <div className="msg-actions">
          <button
            className="link-btn"
            onClick={() => {
              onSaveNote();
              setSaved(true);
              setTimeout(() => setSaved(false), 1500);
            }}
          >
            <BookmarkPlus size={13} /> {saved ? "Saved!" : "Save as note"}
          </button>
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="msg assistant">
      <div className="typing">
        <span /> <span /> <span />
      </div>
    </div>
  );
}

// Resolve the word (or selection) under a right-click for the lookup action.
function wordAtEvent(e: React.MouseEvent): string {
  const sel = window.getSelection();
  const s = sel?.toString().trim();
  if (s) return s.split(/\s+/).slice(0, 6).join(" ");
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let range: Range | null = null;
  if (d.caretRangeFromPoint) range = d.caretRangeFromPoint(e.clientX, e.clientY);
  else if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(e.clientX, e.clientY);
    if (p) {
      range = document.createRange();
      range.setStart(p.offsetNode, p.offset);
      range.collapse(true);
    }
  }
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return "";
  const text = node.textContent || "";
  let a = range!.startOffset;
  let b = a;
  const isW = (ch: string) => !!ch && /[\w'’-]/.test(ch);
  while (a > 0 && isW(text[a - 1])) a--;
  while (b < text.length && isW(text[b])) b++;
  return text.slice(a, b).trim();
}

interface LookupResult {
  q: string;
  local: { type: string; id: string; conversationId?: string; title: string; snippet: string }[];
  web: { summary: string; sources: { url: string; title: string }[]; error?: string };
}
function WordLookup({
  word,
  profileId,
  onOpenConversation,
  onClose,
}: {
  word: string;
  profileId: string;
  onOpenConversation: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState(word);
  const [data, setData] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(term: string) {
    const t = term.trim();
    if (!t) return;
    setLoading(true);
    setData(null);
    try {
      setData(await api.lookup(profileId, t));
    } catch (e) {
      setData({ q: t, local: [], web: { summary: "", sources: [], error: (e as Error).message } });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setQ(word);
    run(word);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal lookup-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3><Search size={16} /> Search context &amp; web</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close"><X size={18} /></button>
        </header>
        <div className="lookup-search">
          <Search size={14} />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run(q)}
            placeholder="Search term…"
          />
          <button className="btn-secondary" onClick={() => run(q)} disabled={loading}>
            {loading ? <Loader size={14} className="spin" /> : "Search"}
          </button>
        </div>

        <div className="lookup-body">
          <section className="lookup-sec">
            <div className="lookup-sec-h"><MessageSquare size={13} /> In your context</div>
            {loading && !data ? (
              <div className="lookup-muted">Searching…</div>
            ) : data && data.local.length ? (
              <ul className="lookup-list">
                {data.local.map((r) => (
                  <li key={`${r.type}-${r.id}`}>
                    <button
                      className="lookup-item"
                      disabled={!r.conversationId}
                      onClick={() => r.conversationId && onOpenConversation(r.conversationId)}
                    >
                      <span className={`lk-kind lk-${r.type}`}>{r.type}</span>
                      <span className="lk-title">{r.title}</span>
                      {r.snippet && <span className="lk-snip">{r.snippet.replace(/[#*`]/g, "")}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="lookup-muted">No matches in your conversations, notes or memory.</div>
            )}
          </section>

          <section className="lookup-sec">
            <div className="lookup-sec-h"><Globe size={13} /> From the web</div>
            {loading && !data ? (
              <div className="lookup-muted">Searching the web…</div>
            ) : data ? (
              <>
                {data.web.summary && <p className="lookup-web-summary">{data.web.summary}</p>}
                {data.web.sources.length ? (
                  <ul className="lookup-list">
                    {data.web.sources.map((s, i) => (
                      <li key={i}>
                        <a className="lookup-item" href={s.url} target="_blank" rel="noreferrer">
                          <ExternalLink size={12} />
                          <span className="lk-title">{s.title || s.url}</span>
                          <span className="lk-snip">{s.url}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="lookup-muted">{data.web.error ? `Web search unavailable: ${data.web.error}` : "No web references found."}</div>
                )}
              </>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  );
}

interface ComposerProps {
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  chips: ContextChip[];
  setChips: React.Dispatch<React.SetStateAction<ContextChip[]>>;
  sending: boolean;
}

function Composer({ draft, setDraft, onSend, chips, setChips, sending }: ComposerProps) {
  const kept = chips.filter((c) => c.kept);
  const suggested = chips.filter((c) => !c.kept);
  const setKept = (id: string, kept: boolean) =>
    setChips((prev) => prev.map((p) => (p.id === id ? { ...p, kept } : p)));
  return (
    <div className="composer-wrap">
      {kept.length > 0 && (
        <div className="context-chips">
          <span className="context-chips-label">
            <Sparkles size={12} /> Context added
          </span>
          {kept.map((c) => (
            <span key={c.id} className="chip kept" title={c.snippet || c.reason}>
              {c.sourceTitle}
              <button onClick={() => setKept(c.id, false)} aria-label="remove context">
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {suggested.length > 0 && (
        <div className="context-chips suggest-row">
          <span className="context-chips-label">
            <Sparkles size={12} /> Suggested context
          </span>
          {suggested.map((c) => (
            <button
              key={c.id}
              className="chip suggest"
              title={`${c.reason}${c.snippet ? ` — ${c.snippet}` : ""}`}
              onClick={() => setKept(c.id, true)}
            >
              <Plus size={11} /> {c.sourceTitle}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <textarea
          value={draft}
          placeholder="Message your AI…  (Enter to send, Shift+Enter for newline)"
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          className="send-btn"
          disabled={!draft.trim() || sending}
          onClick={onSend}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

function EmptyState(props: {
  name: string;
  model: ModelId;
  setModel: (m: ModelId) => void;
  draft: string;
  setDraft: (s: string) => void;
  onSend: () => void;
  chips: ContextChip[];
  setChips: React.Dispatch<React.SetStateAction<ContextChip[]>>;
  sending: boolean;
}) {
  const suggestions = useMemo(
    () => [
      "Summarize what I worked on recently",
      "Help me plan my week",
      "Draft a message about…",
    ],
    [],
  );
  return (
    <main className="chat">
      <header className="chat-header">
        <div className="chat-title">New chat</div>
        <ModelSelector model={props.model} setModel={props.setModel} />
      </header>
      <div className="messages empty-chat">
        <div className="welcome">
          <div className="welcome-mark">◆</div>
          <h2>Hi {props.name} — what's on your mind?</h2>
          <p>
            Your chats, notes &amp; reminders stay private to this profile.
            Relevant context from your history is pulled in automatically.
          </p>
          <div className="suggestions">
            {suggestions.map((s) => (
              <button
                key={s}
                className="suggestion"
                onClick={() => props.setDraft(s)}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
      <Composer
        draft={props.draft}
        setDraft={props.setDraft}
        onSend={props.onSend}
        chips={props.chips}
        setChips={props.setChips}
        sending={props.sending}
      />
    </main>
  );
}
