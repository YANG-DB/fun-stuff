import { useMemo, useRef, useState } from "react";
import { X, Check, Database, Loader, ArrowRight, Pause, Play, Ban, RotateCcw } from "lucide-react";
import { useStore } from "../store";
import { api } from "../services/api";

const DEFAULT_DIR =
  "exports/claude/memorial-project/data-0c106b1d-4c00-4cd5-9d69-2d4af548a171-1782112425-d00ee392-batch-0000";
const CHUNK = 12;
const PER_CONV = "__perconv";
const NEW = "__new";
const SKIP = "__skip";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RowStatus = "pending" | "imported" | "done" | "error";
interface Row { id: string; title: string; profileId: string; status: RowStatus; detail: string; selected: boolean }
interface PeekItem { uuid: string; name: string; summary: string; messages: number; createdAt: number }
type View = "pick" | "assign" | "run";

export function ImportArchive({ onClose }: { onClose: () => void }) {
  const { profiles, activeProfileId, createProfile, selectProfile, reload } = useStore();
  const [dir, setDir] = useState(DEFAULT_DIR);
  const [target, setTarget] = useState<string>(activeProfileId || profiles[0]?.id || NEW);
  const [newName, setNewName] = useState("Claude Archive");
  const [view, setView] = useState<View>("pick");
  const [running, setRunning] = useState(false);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [agg, setAgg] = useState({ imported: 0, total: 0, done: 0, reminders: 0, memorized: 0 });
  const [destId, setDestId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [items, setItems] = useState<PeekItem[]>([]);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState<string>(activeProfileId || profiles[0]?.id || "");
  const [filter, setFilter] = useState("");

  const [rows, setRows] = useState<Record<string, Row>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const cancelRef = useRef(false);

  const updateRow = (id: string, patch: Partial<Row>) =>
    setRows((r) => (r[id] ? { ...r, [id]: { ...r[id], ...patch } } : r));
  const waitPaused = async () => {
    while (pausedRef.current && !cancelRef.current) await sleep(250);
  };
  const detailOf = (x: { topics: number; reminder: boolean; memorized: boolean }) => {
    const parts: string[] = [];
    if (x.topics) parts.push(`${x.topics} topics`);
    if (x.reminder) parts.push("+reminder");
    if (x.memorized) parts.push("memorized");
    return parts.join(" · ") || "no action";
  };

  async function triageIds(pid: string, ids: string[]) {
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (cancelRef.current) return;
      await waitPaused();
      setPhaseLabel("Triaging…");
      try {
        const r = await api.processBatch(pid, ids.slice(i, i + CHUNK));
        setRows((rs) => {
          const n = { ...rs };
          for (const x of r.results) if (n[x.id]) n[x.id] = { ...n[x.id], status: "done", detail: detailOf(x) };
          return n;
        });
        setAgg((s) => ({
          ...s,
          done: s.done + r.processed,
          reminders: s.reminders + r.reminders,
          memorized: s.memorized + r.memorized,
        }));
      } catch (e) {
        setErr((e as Error).message);
      }
    }
  }

  async function start() {
    setErr(null);
    if (target === PER_CONV) {
      try {
        setView("run");
        setPhaseLabel("Loading conversations…");
        setRunning(true);
        const { items } = await api.peekExport(dir.trim());
        const init: Record<string, string> = {};
        for (const it of items) init[it.uuid] = bulk || SKIP;
        setItems(items);
        setAssign(init);
        setRunning(false);
        setView("assign");
      } catch (e) {
        setErr((e as Error).message);
        setRunning(false);
        setView("pick");
      }
      return;
    }
    let pid = target;
    try {
      if (target === NEW) pid = (await createProfile({ name: newName.trim() || "Claude Archive", avatar: "📦" })).id;
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    setDestId(pid);
    setView("run");
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setRunning(true);
    try {
      setPhaseLabel("Importing…");
      const imp = await api.importExport(pid, dir.trim());
      setOrder(imp.items.map((i) => i.id));
      setRows(
        Object.fromEntries(
          imp.items.map((i) => [i.id, { id: i.id, title: i.title, profileId: pid, status: "imported", detail: "", selected: false } as Row]),
        ),
      );
      setAgg({ imported: imp.imported, total: imp.ids.length, done: 0, reminders: 0, memorized: 0 });
      await triageIds(pid, imp.ids);
      if (!cancelRef.current) {
        setPhaseLabel("Building memory…");
        await api.refreshStm(pid).catch(() => {});
        await api.refreshLtm(pid).catch(() => {});
        if (pid === activeProfileId) reload();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
      setPhaseLabel("Done");
    }
  }

  async function runAssignments() {
    setErr(null);
    const assigned = items.filter((it) => assign[it.uuid] && assign[it.uuid] !== SKIP);
    if (!assigned.length) {
      setErr("Assign at least one conversation to a profile.");
      return;
    }
    const groups: Record<string, string[]> = {};
    for (const it of assigned) (groups[assign[it.uuid]] = groups[assign[it.uuid]] || []).push(it.uuid);

    setOrder(assigned.map((i) => i.uuid));
    setRows(
      Object.fromEntries(
        assigned.map((it) => [it.uuid, { id: it.uuid, title: it.name, profileId: assign[it.uuid], status: "pending", detail: "", selected: false } as Row]),
      ),
    );
    setAgg({ imported: 0, total: assigned.length, done: 0, reminders: 0, memorized: 0 });
    setView("run");
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setRunning(true);
    const touched = new Set<string>();
    try {
      for (const pid of Object.keys(groups)) {
        if (cancelRef.current) break;
        await waitPaused();
        setPhaseLabel("Importing…");
        const imp = await api.importExport(pid, dir.trim(), groups[pid]);
        imp.items.forEach((it) => updateRow(it.id, { status: "imported" }));
        setAgg((s) => ({ ...s, imported: s.imported + imp.imported }));
        await triageIds(pid, imp.ids);
        touched.add(pid);
      }
      if (!cancelRef.current) {
        setPhaseLabel("Building memory…");
        for (const pid of touched) {
          await api.refreshStm(pid).catch(() => {});
          await api.refreshLtm(pid).catch(() => {});
        }
      }
      setDestId(touched.size === 1 ? [...touched][0] : null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
      setPhaseLabel("Done");
    }
  }

  async function repeatSelected() {
    const sel = order.map((id) => rows[id]).filter((r) => r && r.selected);
    if (!sel.length) {
      setErr("Select conversations to repeat.");
      return;
    }
    setErr(null);
    cancelRef.current = false;
    pausedRef.current = false;
    setPaused(false);
    setRunning(true);
    const byP: Record<string, string[]> = {};
    for (const r of sel) (byP[r.profileId] = byP[r.profileId] || []).push(r.id);
    try {
      for (const pid of Object.keys(byP)) {
        if (cancelRef.current) break;
        byP[pid].forEach((id) => updateRow(id, { status: "imported", detail: "" }));
        await triageIds(pid, byP[pid]);
        await api.refreshStm(pid).catch(() => {});
        await api.refreshLtm(pid).catch(() => {});
      }
    } finally {
      setRunning(false);
      setPhaseLabel("Done");
    }
  }

  const togglePause = () => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    setPhaseLabel(pausedRef.current ? "Paused" : "Resuming…");
  };
  const cancel = () => {
    cancelRef.current = true;
    pausedRef.current = false;
    setPaused(false);
  };

  const filtered = useMemo(
    () => (filter ? items.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase())) : items),
    [items, filter],
  );
  const assignedCount = useMemo(() => Object.values(assign).filter((v) => v && v !== SKIP).length, [assign]);
  const selectedCount = useMemo(() => order.filter((id) => rows[id]?.selected).length, [order, rows]);
  const destName = profiles.find((x) => x.id === destId)?.name || newName;
  const pct = agg.total ? Math.round((agg.done / agg.total) * 100) : 0;
  const profName = (pid: string) => profiles.find((x) => x.id === pid)?.name || "?";

  return (
    <div className="modal-backdrop" onClick={running ? undefined : onClose}>
      <div className={`modal ${view !== "pick" ? "modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>
            <Database size={17} /> Import Claude archive
          </h3>
          {!running && (
            <button className="icon-btn" onClick={onClose} aria-label="close">
              <X size={18} />
            </button>
          )}
        </header>

        {view === "pick" && (
          <section className="settings-section">
            <label className="field">
              <span>Associate with profile</span>
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {profiles.map((pr) => (
                  <option key={pr.id} value={pr.id}>{pr.avatar} {pr.name}</option>
                ))}
                <option value={NEW}>➕ Create new profile…</option>
                <option value={PER_CONV}>🧭 Decide per conversation…</option>
              </select>
            </label>
            {target === NEW && (
              <label className="field">
                <span>New profile name</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </label>
            )}
            <label className="field">
              <span>Export folder (under <code>exports/</code>)</span>
              <input value={dir} onChange={(e) => setDir(e.target.value)} />
            </label>
            {err && <div className="settings-error">{err}</div>}
            <div className="editor-actions">
              <button className="new-chat-btn" style={{ margin: 0 }} onClick={start}>
                {target === PER_CONV ? "Load conversations…" : "Start import"}
              </button>
            </div>
          </section>
        )}

        {view === "assign" && (
          <section className="settings-section">
            <div className="assign-bar">
              <span>Set all to</span>
              <select value={bulk} onChange={(e) => setBulk(e.target.value)}>
                <option value={SKIP}>— skip —</option>
                {profiles.map((pr) => (<option key={pr.id} value={pr.id}>{pr.avatar} {pr.name}</option>))}
              </select>
              <button className="btn-secondary" onClick={() => {
                const next: Record<string, string> = {};
                for (const it of (filter ? filtered : items)) next[it.uuid] = bulk;
                setAssign((a) => ({ ...a, ...next }));
              }}>Apply</button>
              <input className="assign-filter" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              <span className="assign-count">{assignedCount}/{items.length}</span>
            </div>
            <div className="assign-list">
              {filtered.map((it) => (
                <div className="assign-row" key={it.uuid}>
                  <div className="assign-title">{it.name}<span className="assign-sub">{it.messages} msgs</span></div>
                  <select value={assign[it.uuid] || SKIP} onChange={(e) => setAssign((a) => ({ ...a, [it.uuid]: e.target.value }))}>
                    <option value={SKIP}>— skip —</option>
                    {profiles.map((pr) => (<option key={pr.id} value={pr.id}>{pr.avatar} {pr.name}</option>))}
                  </select>
                </div>
              ))}
            </div>
            {err && <div className="settings-error">{err}</div>}
            <div className="editor-actions">
              <button className="btn-secondary" onClick={() => setView("pick")}>Back</button>
              <button className="new-chat-btn" style={{ margin: 0 }} onClick={runAssignments}>Import {assignedCount} assigned</button>
            </div>
          </section>
        )}

        {view === "run" && (
          <section className="settings-section">
            <div className="run-head">
              <span className="run-phase">
                {running && !paused && <Loader size={13} className="spin" />} {phaseLabel}
              </span>
              <span className="run-stats">
                {agg.imported} imported · {agg.done}/{agg.total || agg.done} triaged · {agg.reminders} ⏰ · {agg.memorized} 🧠
              </span>
            </div>
            {!!agg.total && <div className="imp-bar"><div className="imp-bar-fill" style={{ width: `${pct}%` }} /></div>}

            <div className="run-controls">
              {running ? (
                <>
                  <button className="btn-secondary" onClick={togglePause}>
                    {paused ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Pause</>}
                  </button>
                  <button className="btn-secondary" onClick={cancel}><Ban size={13} /> Cancel</button>
                </>
              ) : (
                <>
                  <button
                    className="link-btn"
                    onClick={() => {
                      const all = selectedCount < order.length;
                      setRows((rs) => {
                        const n = { ...rs };
                        for (const id of order) if (n[id]) n[id] = { ...n[id], selected: all };
                        return n;
                      });
                    }}
                  >
                    {selectedCount < order.length ? "select all" : "clear"}
                  </button>
                  <button className="btn-secondary" disabled={!selectedCount} onClick={repeatSelected}>
                    <RotateCcw size={13} /> Repeat selected ({selectedCount})
                  </button>
                </>
              )}
            </div>

            <div className="assign-list run-list">
              {order.map((id) => {
                const r = rows[id];
                if (!r) return null;
                return (
                  <div className="assign-row" key={id}>
                    {!running && (
                      <input type="checkbox" checked={r.selected} onChange={(e) => updateRow(id, { selected: e.target.checked })} />
                    )}
                    <span className="run-ico">
                      {r.status === "done" ? <Check size={13} className="ok" /> : r.status === "imported" ? <Loader size={12} className="spin" /> : "•"}
                    </span>
                    <div className="assign-title">
                      {r.title}
                      <span className="assign-sub">{profName(r.profileId)}</span>
                    </div>
                    <span className="run-detail">{r.status === "done" ? r.detail : r.status}</span>
                  </div>
                );
              })}
            </div>

            {err && <div className="settings-error">{err}</div>}
            {!running && (
              <div className="editor-actions">
                {destId && destId !== activeProfileId ? (
                  <button className="new-chat-btn" style={{ margin: 0 }} onClick={() => { selectProfile(destId); onClose(); }}>
                    Open {destName} <ArrowRight size={15} />
                  </button>
                ) : (
                  <button className="new-chat-btn" style={{ margin: 0 }} onClick={onClose}>Close</button>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
