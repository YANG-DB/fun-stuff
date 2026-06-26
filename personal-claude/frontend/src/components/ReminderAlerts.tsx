import { useEffect, useRef, useState } from "react";
import { BellRing, Check, Clock, X } from "lucide-react";
import { useStore } from "../store";
import type { Reminder } from "../types";

// Surfaces due reminders as in-app pop-ups (and browser notifications when the
// user has granted permission). Mounted once while a profile is active; polls
// the store on an interval so reminders fire even on an idle tab.

const ALERT_KEY = "personal-claude:alerted";
const HOUR = 3_600_000;

function loadAlerted(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"));
  } catch {
    return new Set();
  }
}
function saveAlerted(s: Set<string>) {
  localStorage.setItem(ALERT_KEY, JSON.stringify([...s]));
}

export function ReminderAlerts() {
  const { reminders, toggleReminder, updateReminder } = useStore();
  const [popups, setPopups] = useState<Reminder[]>([]);
  const alerted = useRef<Set<string>>(loadAlerted());
  const remindersRef = useRef(reminders);
  remindersRef.current = reminders;

  useEffect(() => {
    const check = () => {
      const now = Date.now();
      const due = remindersRef.current.filter(
        (r) => !r.done && r.dueAt <= now && !alerted.current.has(r.id),
      );
      if (!due.length) return;
      for (const r of due) {
        alerted.current.add(r.id);
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification("⏰ Reminder", { body: r.text, tag: r.id });
          } catch {
            /* ignore */
          }
        }
      }
      saveAlerted(alerted.current);
      setPopups((prev) => [
        ...prev,
        ...due.filter((r) => !prev.some((p) => p.id === r.id)),
      ]);
    };
    check();
    const iv = setInterval(check, 20_000);
    return () => clearInterval(iv);
  }, []);

  const dismiss = (id: string) => setPopups((p) => p.filter((r) => r.id !== id));

  const done = (id: string) => {
    const r = remindersRef.current.find((x) => x.id === id);
    toggleReminder(id);
    // a recurring reminder rolls forward — let its next occurrence alert again
    if (r?.repeat && r.repeat !== "none") {
      alerted.current.delete(id);
      saveAlerted(alerted.current);
    }
    dismiss(id);
  };

  const snooze = (id: string) => {
    updateReminder(id, { dueAt: Date.now() + HOUR });
    alerted.current.delete(id); // allow it to re-alert later
    saveAlerted(alerted.current);
    dismiss(id);
  };

  if (!popups.length) return null;

  return (
    <div className="alert-stack">
      {popups.map((r) => (
        <div key={r.id} className="alert-card">
          <div className="alert-head">
            <BellRing size={15} className="alert-ico" />
            <span>Reminder due</span>
            <button className="icon-btn alert-x" onClick={() => dismiss(r.id)}>
              <X size={14} />
            </button>
          </div>
          <div className="alert-text">{r.text}</div>
          <div className="alert-actions">
            <button className="alert-btn primary" onClick={() => done(r.id)}>
              <Check size={13} /> Done
            </button>
            <button className="alert-btn" onClick={() => snooze(r.id)}>
              <Clock size={13} /> Snooze 1h
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Request browser-notification permission (called from a user gesture). */
export async function enableReminderNotifications(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  const res = await Notification.requestPermission();
  return res === "granted";
}
