import { useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../store";
import { MODELS } from "../types";
import type { ModelId, Profile } from "../types";

const COLORS = ["#D97757", "#7C6FF0", "#3BA776", "#E0903C", "#4A9DD8", "#C2548A"];

// Create or edit a profile from the "Who's chatting?" management console.
export function ProfileEditor({
  profile,
  onClose,
}: {
  profile: Profile | null; // null = create
  onClose: () => void;
}) {
  const { createProfile, updateProfile } = useStore();
  const editing = !!profile;

  const [name, setName] = useState(profile?.name ?? "");
  const [tagline, setTagline] = useState(profile?.tagline ?? "");
  const [avatar, setAvatar] = useState(profile?.avatar ?? "🧑");
  const [color, setColor] = useState(profile?.color ?? COLORS[1]);
  const [defaultModel, setDefaultModel] = useState<ModelId>(
    profile?.defaultModel ?? "claude-opus-4-8",
  );
  const [persona, setPersona] = useState(profile?.persona ?? "");
  const [budgetUsd, setBudgetUsd] = useState(String(profile?.budgetUsd ?? 0));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    const data: Partial<Profile> = {
      name: name.trim(),
      tagline: tagline.trim(),
      avatar: avatar.trim() || "🧑",
      color,
      defaultModel,
      persona: persona.trim(),
      budgetUsd: Number(budgetUsd) || 0,
    };
    try {
      if (editing) updateProfile(profile!.id, data);
      else await createProfile(data);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h3>
            <span className="modal-avatar">{avatar || "🧑"}</span>
            {editing ? `Edit ${profile!.name}` : "New profile"}
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <X size={18} />
          </button>
        </header>

        <section className="settings-section editor-grid">
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>Tagline</span>
            <input
              value={tagline}
              placeholder="e.g. Design · brand & UX"
              onChange={(e) => setTagline(e.target.value)}
            />
          </label>

          <div className="field-row">
            <label className="field field-avatar">
              <span>Avatar</span>
              <input
                value={avatar}
                maxLength={4}
                onChange={(e) => setAvatar(e.target.value)}
              />
            </label>
            <label className="field field-budget">
              <span>Budget ($/mo)</span>
              <input
                type="number"
                min="0"
                value={budgetUsd}
                onChange={(e) => setBudgetUsd(e.target.value)}
              />
            </label>
          </div>

          <div className="field">
            <span>Accent color</span>
            <div className="color-row">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`swatch ${c === color ? "active" : ""}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`color ${c}`}
                />
              ))}
            </div>
          </div>

          <label className="field">
            <span>Default model</span>
            <select
              value={defaultModel}
              onChange={(e) => setDefaultModel(e.target.value as ModelId)}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Persona (system prompt)</span>
            <textarea
              rows={3}
              value={persona}
              placeholder="How should the AI behave for this profile?"
              onChange={(e) => setPersona(e.target.value)}
            />
          </label>

          {error && <div className="settings-error">{error}</div>}

          <div className="editor-actions">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="new-chat-btn editor-save" disabled={busy} onClick={save}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create profile"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
