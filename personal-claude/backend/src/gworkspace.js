// Per-profile Google Workspace (Gmail + Calendar) read-only integration.
// Server-side OAuth 2.0 authorization-code flow → refresh token (stored, encrypted)
// → daily sync that turns calendar events + email action-items into reminders.
// Uses global fetch — no extra dependencies.

import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const clientId = () => process.env.GOOGLE_CLIENT_ID || "";
const clientSecret = () => process.env.GOOGLE_CLIENT_SECRET || "";
export const redirectUri = () =>
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:8787/api/google/callback";

export function workspaceConfigured() {
  return !!(clientId() && clientSecret() && process.env.JWT_SECRET);
}

// --- refresh-token encryption at rest (AES-256-GCM, key from JWT_SECRET) -----
function key() {
  return crypto.createHash("sha256").update(process.env.JWT_SECRET || "dev").digest();
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}
export function decrypt(blob) {
  try {
    const [iv, tag, enc] = String(blob).split(".");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// --- OAuth state (carries the profile id through the redirect) ---------------
export function signState(pid, sub) {
  return jwt.sign({ pid, sub, kind: "gconnect" }, process.env.JWT_SECRET, { expiresIn: "10m" });
}
export function verifyState(state) {
  try {
    const p = jwt.verify(state, process.env.JWT_SECRET);
    return p.kind === "gconnect" ? p : null;
  } catch {
    return null;
  }
}

export function authUrl(state) {
  const q = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // force a refresh_token every time
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error_description || j.error || `token ${res.status}`);
  return j;
}

export async function exchangeCode(code) {
  return tokenRequest({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
}

export async function refreshAccess(refreshToken) {
  const j = await tokenRequest({
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
    grant_type: "refresh_token",
  });
  return { accessToken: j.access_token, expiresIn: j.expires_in || 3600 };
}

export async function revoke(token) {
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch {
    /* best-effort */
  }
}

async function api(url, accessToken) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`google api ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// --- Calendar ---------------------------------------------------------------
export async function listCalendarEvents(accessToken, fromTs, toTs, max = 50) {
  const q = new URLSearchParams({
    timeMin: new Date(fromTs).toISOString(),
    timeMax: new Date(toTs).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
  });
  const j = await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, accessToken);
  return (j.items || [])
    .map((e) => {
      const startISO = e.start?.dateTime || e.start?.date;
      if (!startISO) return null;
      return {
        id: e.id,
        instanceRef: `gcal:${e.id}:${startISO}`,
        title: e.summary || "(busy)",
        start: new Date(startISO).getTime(),
        allDay: !e.start?.dateTime,
        location: e.location || "",
      };
    })
    .filter(Boolean);
}

// --- Gmail ------------------------------------------------------------------
export async function listGmail(accessToken, query = "newer_than:2d -category:promotions", max = 20) {
  const q = new URLSearchParams({ q: query, maxResults: String(max) });
  const list = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`, accessToken);
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    try {
      const m = await api(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        accessToken,
      );
      const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
      out.push({
        id,
        subject: h.subject || "(no subject)",
        from: h.from || "",
        date: h.date || "",
        snippet: (m.snippet || "").slice(0, 280),
      });
    } catch {
      /* skip one bad message */
    }
  }
  return out;
}

// --- offline import: Google Takeout (.ics calendar + .mbox mail) ------------
// Lets you test the sync pipeline before connecting the live API.

function icsToMs(v) {
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return 0;
  const [, Y, Mo, D, h = "00", mi = "00", s = "00", z] = m;
  return z === "Z"
    ? Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s)
    : new Date(+Y, +Mo - 1, +D, +h, +mi, +s).getTime();
}

export function parseIcs(text) {
  const t = text.replace(/\r/g, "").replace(/\n[ \t]/g, ""); // strip CR + unfold
  const out = [];
  for (const raw of t.split("BEGIN:VEVENT").slice(1)) {
    const ev = "\n" + raw.split("END:VEVENT")[0];
    const get = (k) => {
      const m = ev.match(new RegExp("\\n" + k + "[^:\\n]*:(.*)"));
      return m ? m[1].trim() : "";
    };
    const dt = ev.match(/\nDTSTART[^:\n]*:(.*)/);
    if (!dt) continue;
    const start = icsToMs(dt[1].trim());
    if (!start) continue;
    const uid = get("UID") || `${start}`;
    out.push({
      instanceRef: `gcal:${uid}:${new Date(start).toISOString()}`,
      title: get("SUMMARY") || "(busy)",
      start,
      location: get("LOCATION"),
    });
  }
  return out;
}

function decodeMimeWord(s) {
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, data) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(data, "base64").toString("utf8");
      return Buffer.from(data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), "binary").toString("utf8");
    } catch {
      return data;
    }
  });
}

export function parseMbox(text, max = 5000) {
  const t = text.replace(/\r/g, "");
  const out = [];
  for (const part of t.split(/\nFrom .*\n/)) {
    if (out.length >= max) break;
    const sep = part.indexOf("\n\n");
    const headU = (sep >= 0 ? part.slice(0, sep) : part).replace(/\n[ \t]/g, " ");
    const body = sep >= 0 ? part.slice(sep + 2) : "";
    const h = {};
    for (const line of headU.split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) {
        const k = line.slice(0, i).trim().toLowerCase();
        if (!(k in h)) h[k] = line.slice(i + 1).trim();
      }
    }
    if (!h.subject && !h.from) continue;
    const snippet = body
      .replace(/<[^>]+>/g, " ")
      .replace(/=\r?\n/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280);
    out.push({
      id: (h["message-id"] || `mbox-${out.length}`).replace(/[<>]/g, ""),
      subject: decodeMimeWord(h.subject || "(no subject)"),
      from: decodeMimeWord(h.from || ""),
      date: h.date || "",
      ts: h.date ? Date.parse(h.date) || 0 : 0,
      snippet,
    });
  }
  return out;
}

// who is connected (for display)
export async function userInfo(accessToken) {
  try {
    return await api("https://www.googleapis.com/oauth2/v2/userinfo", accessToken);
  } catch {
    return {};
  }
}
