import { useState } from "react";
import { Plus, Pencil, Trash2, Settings2, Check, Database } from "lucide-react";
import { useStore } from "../store";
import { MODELS } from "../types";
import type { Profile } from "../types";
import { ProfileEditor } from "./ProfileEditor";
import { ImportArchive } from "./ImportArchive";

// Profile selection + management console ("Who's chatting?").
// Select a profile, or toggle Manage to add / edit / delete profiles.
export function ProfileGate() {
  const { profiles, selectProfile, user, logout, deleteProfile } = useStore();
  const [manage, setManage] = useState(false);
  const [editor, setEditor] = useState<{ profile: Profile | null } | null>(null);
  const [importing, setImporting] = useState(false);

  return (
    <div className="gate">
      <div className="gate-inner">
        <header className="gate-head">
          <div className="brand">
            <img className="brand-logo" src="/favicon.svg" alt="" /> Personal Claude
          </div>
          <h1>Who's chatting?</h1>
          <p className="gate-sub">
            Profiles share one AI account but keep separate history, notes &amp;
            personas.
          </p>
          <div className="gate-actions">
            <button
              className={`manage-toggle ${manage ? "active" : ""}`}
              onClick={() => setManage((m) => !m)}
            >
              {manage ? <Check size={14} /> : <Settings2 size={14} />}
              {manage ? "Done" : "Manage profiles"}
            </button>
            <button className="manage-toggle" onClick={() => setImporting(true)}>
              <Database size={14} /> Import Claude archive
            </button>
          </div>
        </header>

        {profiles.length === 0 && !manage && (
          <p className="gate-sub">
            No profiles are assigned to {user?.email ?? "this account"} yet. Use
            Manage profiles to create one.
          </p>
        )}

        <div className="profile-grid">
          {profiles.map((p) => {
            const count = p.chatCount ?? 0;
            const model =
              MODELS.find((m) => m.id === p.defaultModel)?.label ?? p.defaultModel;
            return (
              <div
                key={p.id}
                className={`profile-card ${manage ? "managing" : ""}`}
                style={{ ["--accent" as string]: p.color }}
                onClick={() => (manage ? setEditor({ profile: p }) : selectProfile(p.id))}
                role="button"
              >
                {manage && (
                  <div className="card-actions">
                    <button
                      className="card-action"
                      title="Edit"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditor({ profile: p });
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="card-action danger"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (
                          confirm(
                            `Delete "${p.name}" and all its chats, notes & reminders? This cannot be undone.`,
                          )
                        ) {
                          deleteProfile(p.id);
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
                <span className="profile-avatar" aria-hidden>
                  {p.avatar}
                </span>
                <span className="profile-name">{p.name}</span>
                <span className="profile-tag">{p.tagline}</span>
                <span className="profile-meta">
                  {count} chats · {model}
                </span>
                {p.google && (
                  <span className="profile-google" title={p.google.email}>
                    <span className="g-dot" /> {p.google.email}
                  </span>
                )}
              </div>
            );
          })}

          {manage && (
            <button
              className="profile-card add-card"
              onClick={() => setEditor({ profile: null })}
            >
              <span className="add-plus">
                <Plus size={28} />
              </span>
              <span className="profile-name">New profile</span>
            </button>
          )}
        </div>

        <footer className="gate-foot">
          {user ? (
            <>
              Signed in as {user.email} ·{" "}
              <button className="link-btn" onClick={logout}>
                Sign out
              </button>
            </>
          ) : (
            <>Shared key metered per profile · {profiles.length} profiles</>
          )}
        </footer>
      </div>

      {editor && (
        <ProfileEditor profile={editor.profile} onClose={() => setEditor(null)} />
      )}
      {importing && <ImportArchive onClose={() => setImporting(false)} />}
    </div>
  );
}
