import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type {
  Conversation,
  Message,
  ModelId,
  Note,
  Profile,
  Reminder,
  MemoryEntry,
} from "./types";
import { api, UnauthorizedError } from "./services/api";
import type { AuthUser } from "./services/api";
import { nextDue } from "./utils";
import { setToken, clearToken, getToken } from "./services/session";

// Backend-backed store. Profiles live in the server's system.db; each profile's
// conversations/notes/reminders live in its own SQLite file. The store holds
// the profile list plus the *active* profile's data, mirroring server state
// with optimistic local updates.

function uid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

interface Store {
  profiles: Profile[];
  conversations: Conversation[];
  notes: Note[];
  reminders: Reminder[];
  memory: MemoryEntry[];
  activeProfileId: string | null;
  activeProfile: Profile | null;
  status: "loading" | "ready" | "error";
  error: string | null;
  profileLoading: boolean;

  user: AuthUser | null;
  authStatus: "checking" | "out" | "in";
  login: (credential: string) => Promise<void>;
  logout: () => void;

  selectProfile: (id: string | null) => void;
  reload: () => void;
  loadMock: () => Promise<void>;
  createProfile: (data: Partial<Profile>) => Promise<Profile>;
  updateProfile: (id: string, patch: Partial<Profile>) => void;
  deleteProfile: (id: string) => Promise<void>;

  createConversation: (model: ModelId) => Promise<Conversation>;
  continueCluster: (ids: string[], title?: string) => Promise<Conversation>;
  appendMessage: (conversationId: string, msg: Message) => Promise<void>;
  updateMessage: (
    conversationId: string,
    msgId: string,
    content: string,
    persist?: boolean,
  ) => Promise<void>;
  renameConversation: (id: string, title: string) => void;
  togglePin: (id: string) => void;
  deleteConversation: (id: string) => void;
  setConversationDeleted: (id: string, deleted: boolean) => void;
  bulkSetDeleted: (ids: string[], deleted: boolean) => Promise<void>;

  addNote: (note: Omit<Note, "id" | "createdAt" | "updatedAt">) => void;
  updateNote: (id: string, patch: Partial<Note>) => void;
  deleteNote: (id: string) => void;

  addReminder: (r: Omit<Reminder, "id">) => void;
  toggleReminder: (id: string) => void;
  updateReminder: (id: string, patch: Partial<Reminder>) => void;
  deleteReminder: (id: string) => void;

  memorize: (
    conversationId: string,
  ) => Promise<{ id: string; subject: string; summary: string; topics: string[] }>;
  deleteMemory: (id: string) => void;

  memoryFiles: { stm: string; stmUpdated: number; ltm: string; ltmUpdated: number };
  refreshStm: () => Promise<void>;
  refreshLtm: () => Promise<void>;
  refreshStmSoon: () => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [memoryFiles, setMemoryFiles] = useState({
    stm: "",
    stmUpdated: 0,
    ltm: "",
    ltmUpdated: 0,
  });
  const stmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authStatus, setAuthStatus] = useState<"checking" | "out" | "in">(
    "checking",
  );

  const loadProfiles = useCallback(async () => {
    const ps = await api.listProfiles();
    setProfiles(ps);
  }, []);

  // Bootstrap: decide whether a login is required, then (if signed in) load data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.authConfig();
        if (cancelled) return;
        if (!cfg.authRequired) {
          // Open mode (no Google keys on server).
          setAuthStatus("in");
          await loadProfiles();
        } else if (getToken()) {
          try {
            const me = await api.me();
            if (cancelled) return;
            setUser(me.user);
            setAuthStatus("in");
            await loadProfiles();
          } catch (e) {
            if (e instanceof UnauthorizedError) setAuthStatus("out");
            else throw e;
          }
        } else {
          setAuthStatus("out");
        }
        if (!cancelled) setStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadProfiles]);

  const login = useCallback(
    async (credential: string) => {
      const { token, user: u } = await api.loginGoogle(credential);
      setToken(token);
      setUser(u);
      setAuthStatus("in");
      await loadProfiles();
    },
    [loadProfiles],
  );

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    setActiveProfileId(null);
    setProfiles([]);
    setConversations([]);
    setNotes([]);
    setReminders([]);
    setAuthStatus("out");
  }, []);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  const loadProfileData = useCallback((id: string) => {
    setProfileLoading(true);
    Promise.all([
      api.listConversations(id),
      api.listNotes(id),
      api.listReminders(id),
      api.listMemory(id),
      api.getMemoryFiles(id),
    ])
      .then(([c, n, r, m, mf]) => {
        setConversations(c);
        setNotes(n);
        setReminders(r);
        setMemory(m);
        setMemoryFiles(mf);
      })
      .catch((e) => setError(e.message))
      .finally(() => setProfileLoading(false));
  }, []);

  // Load the active profile's data whenever it changes.
  const selectProfile = useCallback(
    (id: string | null) => {
      setActiveProfileId(id);
      setConversations([]);
      setNotes([]);
      setReminders([]);
      setMemory([]);
      setMemoryFiles({ stm: "", stmUpdated: 0, ltm: "", ltmUpdated: 0 });
      if (id) loadProfileData(id);
    },
    [loadProfileData],
  );

  // Re-fetch the active profile's data (e.g. after an import) and refresh counts.
  const reload = useCallback(() => {
    if (!activeProfileId) return;
    loadProfileData(activeProfileId);
    api
      .listProfiles()
      .then(setProfiles)
      .catch((e) => setError(e.message));
  }, [activeProfileId, loadProfileData]);

  const updateProfile = useCallback((id: string, patch: Partial<Profile>) => {
    setProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    api.updateProfile(id, patch).catch((e) => setError(e.message));
  }, []);

  const loadMock = useCallback(async () => {
    if (!activeProfileId) return;
    await api.generateMock(activeProfileId);
    reload();
  }, [activeProfileId, reload]);

  const createProfile = useCallback(async (data: Partial<Profile>) => {
    const p = await api.createProfile(data);
    setProfiles((prev) => [...prev, p]);
    return p;
  }, []);

  const deleteProfile = useCallback(async (id: string) => {
    setProfiles((prev) => prev.filter((p) => p.id !== id));
    if (activeProfileId === id) setActiveProfileId(null);
    await api.deleteProfile(id).catch((e) => setError(e.message));
  }, [activeProfileId]);

  const bumpChatCount = useCallback((pid: string, delta: number) => {
    setProfiles((prev) =>
      prev.map((p) =>
        p.id === pid ? { ...p, chatCount: (p.chatCount ?? 0) + delta } : p,
      ),
    );
  }, []);

  const createConversation = useCallback(
    async (model: ModelId): Promise<Conversation> => {
      const pid = activeProfileId!;
      const c = await api.createConversation(pid, model);
      setConversations((prev) => [c, ...prev]);
      bumpChatCount(pid, 1);
      return c;
    },
    [activeProfileId, bumpChatCount],
  );

  const continueCluster = useCallback(
    async (ids: string[], title?: string): Promise<Conversation> => {
      const pid = activeProfileId!;
      const c = await api.continueCluster(pid, ids, title);
      setConversations((prev) => [c, ...prev]);
      bumpChatCount(pid, 1);
      return c;
    },
    [activeProfileId, bumpChatCount],
  );

  const appendMessage = useCallback(
    async (conversationId: string, msg: Message): Promise<void> => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: [...c.messages, msg],
                updatedAt: Date.now(),
                title:
                  c.messages.length === 0 && msg.role === "user"
                    ? msg.content.slice(0, 48)
                    : c.title,
              }
            : c,
        ),
      );
      await api.addMessage(activeProfileId!, conversationId, msg);
    },
    [activeProfileId],
  );

  const updateMessage = useCallback(
    async (conversationId: string, msgId: string, content: string, persist = false) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === msgId ? { ...m, content } : m,
                ),
              }
            : c,
        ),
      );
      if (persist) {
        try {
          await api.patchMessage(activeProfileId!, conversationId, msgId, content);
        } catch (e) {
          setError((e as Error).message);
        }
      }
    },
    [activeProfileId],
  );

  const renameConversation = useCallback(
    (id: string, title: string) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      );
      api.patchConversation(activeProfileId!, id, { title }).catch(() => {});
    },
    [activeProfileId],
  );

  const togglePin = useCallback(
    (id: string) => {
      let next = false;
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c;
          next = !c.pinned;
          return { ...c, pinned: next };
        }),
      );
      api.patchConversation(activeProfileId!, id, { pinned: next }).catch(() => {});
    },
    [activeProfileId],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      bumpChatCount(activeProfileId!, -1);
      api.deleteConversation(activeProfileId!, id).catch(() => {});
    },
    [activeProfileId, bumpChatCount],
  );

  // Soft-delete / restore: hide from the UI but keep recoverable.
  const setConversationDeleted = useCallback(
    (id: string, deleted: boolean) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, deleted } : c)));
      bumpChatCount(activeProfileId!, deleted ? -1 : 1);
      api.patchConversation(activeProfileId!, id, { deleted }).catch(() => {});
    },
    [activeProfileId, bumpChatCount],
  );

  const bulkSetDeleted = useCallback(
    async (ids: string[], deleted: boolean) => {
      const set = new Set(ids);
      setConversations((prev) => prev.map((c) => (set.has(c.id) ? { ...c, deleted } : c)));
      bumpChatCount(activeProfileId!, (deleted ? -1 : 1) * ids.length);
      await api.bulkSetDeleted(activeProfileId!, ids, deleted).catch(() => {});
    },
    [activeProfileId, bumpChatCount],
  );

  const addNote = useCallback(
    (note: Omit<Note, "id" | "createdAt" | "updatedAt">) => {
      const optimistic: Note = {
        ...note,
        id: uid("n"),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      setNotes((prev) => [optimistic, ...prev]);
      api
        .addNote(activeProfileId!, note)
        .then((saved) =>
          setNotes((prev) =>
            prev.map((n) => (n.id === optimistic.id ? saved : n)),
          ),
        )
        .catch((e) => setError(e.message));
    },
    [activeProfileId],
  );

  const updateNote = useCallback(
    (id: string, patch: Partial<Note>) => {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === id ? { ...n, ...patch, updatedAt: Date.now() } : n,
        ),
      );
      api.patchNote(activeProfileId!, id, patch).catch(() => {});
    },
    [activeProfileId],
  );

  const deleteNote = useCallback(
    (id: string) => {
      setNotes((prev) => prev.filter((n) => n.id !== id));
      api.deleteNote(activeProfileId!, id).catch(() => {});
    },
    [activeProfileId],
  );

  const addReminder = useCallback(
    (r: Omit<Reminder, "id">) => {
      const optimistic: Reminder = { ...r, id: uid("r") };
      setReminders((prev) => [optimistic, ...prev]);
      api
        .addReminder(activeProfileId!, r)
        .then((saved) =>
          setReminders((prev) =>
            prev.map((x) => (x.id === optimistic.id ? saved : x)),
          ),
        )
        .catch((e) => setError(e.message));
    },
    [activeProfileId],
  );

  const toggleReminder = useCallback(
    (id: string) => {
      const r = reminders.find((x) => x.id === id);
      // Completing a recurring reminder rolls it forward to the next occurrence.
      if (r && r.repeat && r.repeat !== "none" && !r.done) {
        const nd = nextDue(r.dueAt, r.repeat);
        setReminders((prev) => prev.map((x) => (x.id === id ? { ...x, dueAt: nd, done: false } : x)));
        api.patchReminder(activeProfileId!, id, { dueAt: nd }).catch(() => {});
        return;
      }
      const next = !(r?.done);
      setReminders((prev) => prev.map((x) => (x.id === id ? { ...x, done: next } : x)));
      api.patchReminder(activeProfileId!, id, { done: next }).catch(() => {});
    },
    [activeProfileId, reminders],
  );

  const updateReminder = useCallback(
    (id: string, patch: Partial<Reminder>) => {
      setReminders((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
      api.patchReminder(activeProfileId!, id, patch).catch(() => {});
    },
    [activeProfileId],
  );

  const deleteReminder = useCallback(
    (id: string) => {
      setReminders((prev) => prev.filter((r) => r.id !== id));
      api.deleteReminder(activeProfileId!, id).catch(() => {});
    },
    [activeProfileId],
  );

  const memorize = useCallback(
    async (conversationId: string) => {
      const r = await api.memorizeChat(activeProfileId!, conversationId);
      reload(); // refresh memory list + updated concepts
      return r;
    },
    [activeProfileId, reload],
  );

  const deleteMemory = useCallback(
    (id: string) => {
      setMemory((prev) => prev.filter((m) => m.id !== id));
      api.deleteMemory(activeProfileId!, id).catch(() => {});
    },
    [activeProfileId],
  );

  const refreshStm = useCallback(async () => {
    if (!activeProfileId) return;
    const r = await api.refreshStm(activeProfileId);
    setMemoryFiles((m) => ({ ...m, stm: r.content, stmUpdated: r.updatedAt }));
  }, [activeProfileId]);

  const refreshLtm = useCallback(async () => {
    if (!activeProfileId) return;
    const r = await api.refreshLtm(activeProfileId);
    setMemoryFiles((m) => ({ ...m, ltm: r.content, ltmUpdated: r.updatedAt }));
  }, [activeProfileId]);

  // Debounced auto-refresh of STM after activity (coalesces rapid messages).
  const refreshStmSoon = useCallback(() => {
    if (stmTimer.current) clearTimeout(stmTimer.current);
    stmTimer.current = setTimeout(() => {
      refreshStm().catch(() => {});
    }, 25_000);
  }, [refreshStm]);

  const value: Store = {
    profiles,
    conversations,
    notes,
    reminders,
    memory,
    activeProfileId,
    activeProfile,
    status,
    error,
    profileLoading,
    user,
    authStatus,
    login,
    logout,
    selectProfile,
    reload,
    loadMock,
    createProfile,
    updateProfile,
    deleteProfile,
    createConversation,
    continueCluster,
    appendMessage,
    updateMessage,
    renameConversation,
    togglePin,
    deleteConversation,
    setConversationDeleted,
    bulkSetDeleted,
    addNote,
    updateNote,
    deleteNote,
    addReminder,
    toggleReminder,
    updateReminder,
    deleteReminder,
    memorize,
    deleteMemory,
    memoryFiles,
    refreshStm,
    refreshLtm,
    refreshStmSoon,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore must be used within StoreProvider");
  return v;
}
