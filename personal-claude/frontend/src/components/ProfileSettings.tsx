import { useEffect, useRef, useState } from "react";
import { X, Check, Unlink, Upload, Plus, Trash2, Download } from "lucide-react";
import { useStore } from "../store";
import { api } from "../services/api";
import type { ProfileDetails } from "../services/api";
import {
  downloadText,
  combinedMd,
  ltmMd,
  stmMd,
  notesMd,
  remindersMd,
  memoryMd,
  exportProfile,
} from "../services/exportData";
import {
  demoConnect,
  isGoogleConfigured,
  renderGoogleButton,
} from "../services/googleAuth";

// Per-profile settings, focused on linking a Google identity (Sign in with
// Google). Identity only — used to label the profile with a real account; no
// Google API scopes are requested.
export function ProfileSettings({ onClose }: { onClose: () => void }) {
  const { activeProfile, updateProfile, reload, notes, reminders, memory, memoryFiles, conversations } = useStore();
  const profile = activeProfile!;
  const btnRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [importState, setImportState] = useState<
    { kind: "idle" | "busy" } | { kind: "done"; msg: string } | { kind: "error"; msg: string }
  >({ kind: "idle" });
  const [emails, setEmails] = useState((profile.allowedEmails ?? []).join("\n"));
  const [emailsSaved, setEmailsSaved] = useState(false);
  const [ctx, setCtx] = useState("");
  const [ctxSaved, setCtxSaved] = useState(false);
  const [details, setDetails] = useState<ProfileDetails>({});
  const [detailsSaved, setDetailsSaved] = useState(false);
  const configured = isGoogleConfigured();

  const patchDetails = (p: Partial<ProfileDetails>) => setDetails((d) => ({ ...d, ...p }));
  const setSocial = (i: number, p: Partial<{ label: string; url: string }>) =>
    setDetails((d) => {
      const socials = [...(d.socials || [])];
      socials[i] = { ...(socials[i] || { label: "", url: "" }), ...p };
      return { ...d, socials };
    });
  const setCustom = (i: number, p: Partial<{ label: string; value: string }>) =>
    setDetails((d) => {
      const custom = [...(d.custom || [])];
      custom[i] = { ...(custom[i] || { label: "", value: "" }), ...p };
      return { ...d, custom };
    });
  async function saveDetails() {
    await api.putDetails(profile.id, details);
    setDetailsSaved(true);
    setTimeout(() => setDetailsSaved(false), 1500);
  }

  const settings = {
    thinking: false,
    effort: "high",
    webTools: true,
    memory: false,
    ...(profile.settings || {}),
  };
  const setSetting = (patch: Record<string, unknown>) =>
    updateProfile(profile.id, { settings: { ...settings, ...patch } as never });

  useEffect(() => {
    api.getContext(profile.id).then((r) => setCtx(r.content)).catch(() => {});
    api.getDetails(profile.id).then((d) => setDetails(d || {})).catch(() => {});
  }, [profile.id]);

  const exportName = (suffix: string) =>
    `${profile.name.replace(/\s+/g, "_")}-${suffix}.md`;
  const bundle = {
    profileName: profile.name,
    ltm: memoryFiles.ltm,
    stm: memoryFiles.stm,
    notes: notes.filter((n) => n.profileId === profile.id),
    reminders: reminders.filter((r) => r.profileId === profile.id),
    memory: memory.filter((m) => m.profileId === profile.id),
  };
  const profileBundle = () => ({
    name: profile.name,
    tagline: profile.tagline,
    persona: profile.persona,
    model: profile.defaultModel,
    google: profile.google ? { email: profile.google.email, name: profile.google.name } : null,
    allowedEmails: profile.allowedEmails || [],
    budgetUsd: profile.budgetUsd,
    spentUsd: profile.spentUsd,
    tokens: profile.tokens,
    details,
    context: ctx,
    ltm: memoryFiles.ltm,
    stm: memoryFiles.stm,
    notes: bundle.notes,
    reminders: bundle.reminders,
    memory: bundle.memory,
    conversations: conversations
      .filter((c) => c.profileId === profile.id && !c.deleted)
      .map((c) => ({ title: c.title, source: c.source, summary: c.summary, concepts: c.concepts, updatedAt: c.updatedAt, messages: c.messages.length })),
  });

  function saveEmails() {
    const list = emails
      .split(/[\n,]/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    updateProfile(profile.id, { allowedEmails: list });
    setEmailsSaved(true);
    setTimeout(() => setEmailsSaved(false), 1500);
  }

  async function onImportFile(file: File) {
    setImportState({ kind: "busy" });
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const stats = await api.importClaude(profile.id, data);
      setImportState({
        kind: "done",
        msg: `Imported ${stats.imported} chat${stats.imported === 1 ? "" : "s"} (${stats.messages} messages)${stats.skipped ? `, skipped ${stats.skipped}` : ""}.`,
      });
      reload();
    } catch (e) {
      const m = e instanceof SyntaxError ? "That file isn't valid JSON." : (e as Error).message;
      setImportState({ kind: "error", msg: m });
    }
  }

  useEffect(() => {
    if (profile.google || configured === false || !btnRef.current) return;
    renderGoogleButton(
      btnRef.current,
      (identity) => {
        updateProfile(profile.id, { google: identity });
        setError(null);
      },
      (msg) => setError(msg),
    );
  }, [profile.id, profile.google, configured, updateProfile]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal profile-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>
            <span className="modal-avatar">{profile.avatar}</span>
            {profile.name}'s settings
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <X size={18} />
          </button>
        </header>

        <div className="ps-grid">
        <section className="settings-section">
          <div className="settings-label">Google account</div>
          <p className="settings-hint">
            Link a Google identity to this profile (name, email &amp; avatar).
            Identity only — no Drive, Gmail or Calendar access is requested.
          </p>

          {profile.google ? (
            <div className="google-linked">
              {profile.google.picture ? (
                <img
                  className="google-pic"
                  src={profile.google.picture}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="google-pic placeholder">
                  {profile.google.name.charAt(0).toUpperCase()}
                </span>
              )}
              <div className="google-id">
                <div className="google-name">
                  <Check size={13} className="ok" /> {profile.google.name}
                </div>
                <div className="google-email">{profile.google.email}</div>
              </div>
              <button
                className="btn-secondary"
                onClick={() => updateProfile(profile.id, { google: undefined })}
              >
                <Unlink size={14} /> Disconnect
              </button>
            </div>
          ) : configured ? (
            <div className="google-connect">
              <div ref={btnRef} />
              {error && <div className="settings-error">{error}</div>}
            </div>
          ) : (
            <div className="google-connect">
              <button
                className="btn-google-demo"
                onClick={() =>
                  updateProfile(profile.id, { google: demoConnect(profile.name) })
                }
              >
                <GoogleG /> Continue with Google
              </button>
              <div className="settings-note">
                Demo mode — set <code>VITE_GOOGLE_CLIENT_ID</code> for real Google
                sign-in.
              </div>
              {error && <div className="settings-error">{error}</div>}
            </div>
          )}
        </section>

        <section className="settings-section">
          <div className="settings-label">Access (allowed emails)</div>
          <p className="settings-hint">
            One Google email per line. <strong>Leave empty</strong> to keep this
            profile open to anyone signed in. Add emails to restrict it to only
            those people.
          </p>
          <textarea
            className="emails-input"
            rows={3}
            placeholder="alice@gmail.com&#10;bob@company.com"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
          />
          <button className="btn-secondary" onClick={saveEmails}>
            {emailsSaved ? (
              <>
                <Check size={14} className="ok" /> Saved
              </>
            ) : (
              "Save access list"
            )}
          </button>
        </section>

        <section className="settings-section">
          <div className="settings-label">Import Claude history</div>
          <p className="settings-hint">
            Bootstrap this profile from a Claude.ai export. Select the{" "}
            <code>conversations.json</code> file (from Claude → Settings → Export
            data). Re-importing is safe — existing chats are skipped.
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportFile(f);
              e.target.value = "";
            }}
          />
          <button
            className="btn-secondary"
            disabled={importState.kind === "busy"}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={14} />{" "}
            {importState.kind === "busy" ? "Importing…" : "Choose conversations.json"}
          </button>
          {importState.kind === "done" && (
            <div className="settings-success">
              <Check size={13} className="ok" /> {importState.msg}
            </div>
          )}
          {importState.kind === "error" && (
            <div className="settings-error">{importState.msg}</div>
          )}
        </section>

        <section className="settings-section">
          <div className="settings-label">Chat settings (Claude)</div>
          <label className="set-row">
            <span>Extended thinking (adaptive)</span>
            <input
              type="checkbox"
              checked={settings.thinking}
              onChange={(e) => setSetting({ thinking: e.target.checked })}
            />
          </label>
          <label className="set-row">
            <span>Reasoning effort</span>
            <select
              value={settings.effort}
              onChange={(e) => setSetting({ effort: e.target.value })}
            >
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
          </label>
          <label className="set-row">
            <span>Web search &amp; fetch</span>
            <input
              type="checkbox"
              checked={settings.webTools}
              onChange={(e) => setSetting({ webTools: e.target.checked })}
            />
          </label>
          <label className="set-row">
            <span>Memory tool (local files)</span>
            <input
              type="checkbox"
              checked={settings.memory}
              onChange={(e) => setSetting({ memory: e.target.checked })}
            />
          </label>
          <p className="settings-note">
            Also changeable mid-chat via <code>/think</code>, <code>/effort</code>,{" "}
            <code>/web</code>, <code>/memory</code>.
          </p>
        </section>

        <section className="settings-section">
          <div className="settings-label">Personal details (saved to long-term memory)</div>
          <p className="settings-hint">
            Your social accounts, websites and personal facts. Saved into this
            profile's <code>LTM.md</code> so the assistant always knows them — and
            preserved across memory consolidation.
          </p>
          <div className="details-grid">
            <label className="field">
              <span>Name</span>
              <input value={details.name || ""} onChange={(e) => patchDetails({ name: e.target.value })} />
            </label>
            <label className="field">
              <span>Location</span>
              <input value={details.location || ""} onChange={(e) => patchDetails({ location: e.target.value })} />
            </label>
            <label className="field">
              <span>Role / occupation</span>
              <input value={details.role || ""} onChange={(e) => patchDetails({ role: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>About / bio</span>
            <textarea
              className="emails-input"
              rows={2}
              value={details.bio || ""}
              onChange={(e) => patchDetails({ bio: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Websites (one per line)</span>
            <textarea
              className="emails-input"
              rows={2}
              placeholder={"https://yang-db.github.io\nhttps://mysite.com"}
              value={(details.websites || []).join("\n")}
              onChange={(e) => patchDetails({ websites: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
            />
          </label>

          <div className="settings-sublabel">Social accounts</div>
          {(details.socials || []).map((s, i) => (
            <div className="kv-row" key={i}>
              <input
                placeholder="Platform (e.g. GitHub)"
                value={s.label}
                onChange={(e) => setSocial(i, { label: e.target.value })}
              />
              <input
                placeholder="URL or @handle"
                value={s.url}
                onChange={(e) => setSocial(i, { url: e.target.value })}
              />
              <button
                className="icon-btn"
                title="Remove"
                onClick={() => patchDetails({ socials: (details.socials || []).filter((_, j) => j !== i) })}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            className="btn-secondary btn-add"
            onClick={() => patchDetails({ socials: [...(details.socials || []), { label: "", url: "" }] })}
          >
            <Plus size={13} /> Add social account
          </button>

          <div className="settings-sublabel">Other personal details</div>
          {(details.custom || []).map((c, i) => (
            <div className="kv-row" key={i}>
              <input
                placeholder="Label (e.g. Phone)"
                value={c.label}
                onChange={(e) => setCustom(i, { label: e.target.value })}
              />
              <input
                placeholder="Value"
                value={c.value}
                onChange={(e) => setCustom(i, { value: e.target.value })}
              />
              <button
                className="icon-btn"
                title="Remove"
                onClick={() => patchDetails({ custom: (details.custom || []).filter((_, j) => j !== i) })}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            className="btn-secondary btn-add"
            onClick={() => patchDetails({ custom: [...(details.custom || []), { label: "", value: "" }] })}
          >
            <Plus size={13} /> Add detail
          </button>

          <div>
            <button className="btn-secondary" onClick={saveDetails}>
              {detailsSaved ? (<><Check size={14} className="ok" /> Saved to LTM</>) : "Save personal details"}
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-label">Export data (markdown)</div>
          <p className="settings-hint">
            Download this profile's memory and workspace as <code>.md</code> files.
          </p>
          <div className="export-row">
            <button className="btn-secondary" onClick={() => downloadText(exportName("export"), combinedMd(bundle))}>
              <Download size={14} /> Everything
            </button>
            <button className="btn-secondary" onClick={() => downloadText(exportName("LTM"), ltmMd(bundle.ltm))}>
              <Download size={14} /> LTM
            </button>
            <button className="btn-secondary" onClick={() => downloadText(exportName("STM"), stmMd(bundle.stm))}>
              <Download size={14} /> STM
            </button>
            <button className="btn-secondary" onClick={() => downloadText(exportName("notes"), notesMd(bundle.notes))}>
              <Download size={14} /> Notes
            </button>
            <button className="btn-secondary" onClick={() => downloadText(exportName("reminders"), remindersMd(bundle.reminders))}>
              <Download size={14} /> Reminders
            </button>
            <button className="btn-secondary" onClick={() => downloadText(exportName("memory"), memoryMd(bundle.memory))}>
              <Download size={14} /> Memory
            </button>
          </div>
          <div className="settings-sublabel">Full profile</div>
          <div className="export-row">
            <button className="btn-secondary" onClick={() => exportProfile(profileBundle(), "json")}>
              <Download size={14} /> JSON
            </button>
            <button className="btn-secondary" onClick={() => exportProfile(profileBundle(), "md")}>
              <Download size={14} /> Markdown
            </button>
            <button className="btn-secondary" onClick={() => exportProfile(profileBundle(), "pdf")}>
              <Download size={14} /> PDF
            </button>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-label">User context (always injected)</div>
          <p className="settings-hint">
            Hand-maintained profile (work, projects, preferences). Injected into the
            system prompt inside <code>&lt;user_context&gt;</code> on every request.
            Markdown.
          </p>
          <textarea
            className="emails-input"
            rows={6}
            value={ctx}
            onChange={(e) => setCtx(e.target.value)}
            placeholder={"e.g.\n- I'm a founder building a local-first AI app\n- Prefer concise, technical answers\n- Stack: React + Node + SQLite"}
          />
          <button
            className="btn-secondary"
            onClick={async () => {
              await api.putContext(profile.id, ctx);
              setCtxSaved(true);
              setTimeout(() => setCtxSaved(false), 1500);
            }}
          >
            {ctxSaved ? (
              <>
                <Check size={14} className="ok" /> Saved
              </>
            ) : (
              "Save user context"
            )}
          </button>
        </section>

        <section className="settings-section">
          <div className="settings-label">Persona</div>
          <p className="settings-persona">{profile.persona}</p>
        </section>
        </div>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.5 30.1 0 24 0 14.6 0 6.4 5.4 2.5 13.3l7.8 6c1.9-5.6 7.1-9.8 13.7-9.8z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7c4.3-3.9 6.8-9.7 6.8-17.4z"
      />
      <path
        fill="#FBBC05"
        d="M10.3 28.3c-.5-1.4-.8-3-.8-4.8s.3-3.3.8-4.8l-7.8-6C.9 16.1 0 19.9 0 24s.9 7.9 2.5 11.3l7.8-7z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.1 0 11.3-2 15-5.5l-7.3-5.7c-2 1.4-4.7 2.3-7.7 2.3-6.6 0-11.8-4.2-13.7-9.8l-7.8 6C6.4 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}
