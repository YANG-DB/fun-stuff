import type { Reminder } from "../types";

// Calendar sync helpers — export a reminder as a standard .ics file (works with
// Apple/Google/Outlook calendars) or open a Google Calendar "add event" link.
// No accounts/OAuth needed: the user drops the event into whatever calendar they use.

const HALF_HOUR = 30 * 60 * 1000;

function fmtICS(ts: number): string {
  // YYYYMMDDTHHMMSSZ (UTC)
  return new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
function esc(s: string): string {
  return s.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

export function buildICS(r: Reminder): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Personal Claude//Reminders//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${r.id}@personal-claude`,
    `DTSTAMP:${fmtICS(Date.now())}`,
    `DTSTART:${fmtICS(r.dueAt)}`,
    `DTEND:${fmtICS(r.dueAt + HALF_HOUR)}`,
    `SUMMARY:${esc(r.text)}`,
    "BEGIN:VALARM",
    "TRIGGER:-PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${esc(r.text)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

export function downloadICS(r: Reminder) {
  const blob = new Blob([buildICS(r)], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `reminder-${r.id}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function googleCalUrl(r: Reminder): string {
  const dates = `${fmtICS(r.dueAt)}/${fmtICS(r.dueAt + HALF_HOUR)}`;
  return (
    "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    `&text=${encodeURIComponent(r.text)}&dates=${dates}` +
    `&details=${encodeURIComponent("From Personal Claude")}`
  );
}
