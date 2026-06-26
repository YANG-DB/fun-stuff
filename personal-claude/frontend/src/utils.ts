import { marked } from "marked";
import type { Conversation, Reminder, Repeat } from "./types";

marked.setOptions({ breaks: true, gfm: true });

/** Render trusted-ish markdown to HTML for chat/notes. */
export function md(src: string): string {
  return marked.parse(src) as string;
}

/** Compact token count: 980 → "980", 12345 → "12.3k", 2_100_000 → "2.1M". */
export function formatTokens(n: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Compact relative time: "2h", "3d", "now". */
export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const m = 60_000;
  const h = 3_600_000;
  const d = 86_400_000;
  const fmt = (n: number, unit: string) => `${Math.round(n)}${unit}`;
  if (abs < m) return "now";
  if (abs < h) return fmt(abs / m, "m");
  if (abs < d) return fmt(abs / h, "h");
  if (abs < 7 * d) return fmt(abs / d, "d");
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ---- Chat organization lenses --------------------------------------------

export type ChatView = "calendar" | "weekly" | "graph" | "hot";

export interface ChatGroup {
  key: string;
  label: string;
  meta?: string;
  chats: Conversation[];
}

const DAY = 86_400_000;
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function startOfWeek(ts: number): number {
  const d = new Date(ts);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

/** Group a profile's chats by the chosen lens. Input should be pre-sorted desc. */
export function groupChats(chats: Conversation[], view: ChatView): ChatGroup[] {
  if (view === "weekly") return byWeek(chats);
  if (view === "graph") return byConcept(chats);
  if (view === "hot") return hotTopics(chats);
  return byDay(chats);
}

export type GroupBy = "date" | "subject" | "topic" | "length";

/** Group the sidebar chat list by a chosen parameter. Input pre-sorted desc. */
export function groupChatList(chats: Conversation[], by: GroupBy): ChatGroup[] {
  if (by === "topic") return byConcept(chats);
  if (by === "subject") return bySubject(chats);
  if (by === "length") return byLength(chats);
  return byDay(chats);
}

function bySubject(chats: Conversation[]): ChatGroup[] {
  const map = new Map<string, Conversation[]>();
  for (const c of chats) {
    const ch = (c.title.trim()[0] || "#").toUpperCase();
    const k = /[A-Z]/.test(ch) ? ch : "#";
    (map.get(k) ?? map.set(k, []).get(k)!).push(c);
  }
  return [...map.keys()]
    .sort()
    .map((k) => ({ key: k, label: k, meta: `${map.get(k)!.length}`, chats: map.get(k)! }));
}

function byLength(chats: Conversation[]): ChatGroup[] {
  const buckets = [
    { key: "long", label: "Long · 16+ msgs", min: 16 },
    { key: "medium", label: "Medium · 7–15", min: 7 },
    { key: "short", label: "Short · 3–6", min: 3 },
    { key: "quick", label: "Quick · 1–2", min: 0 },
  ];
  const out: ChatGroup[] = [];
  for (const b of buckets) {
    const list = chats.filter((c) => {
      const n = c.messages?.length || 0;
      const bucket = buckets.find((x) => n >= x.min)!; // first bucket whose min is met
      return bucket.key === b.key;
    });
    if (list.length) out.push({ key: b.key, label: b.label, meta: `${list.length}`, chats: list });
  }
  return out;
}

function byDay(chats: Conversation[]): ChatGroup[] {
  const today = startOfDay(Date.now());
  const map = new Map<number, Conversation[]>();
  for (const c of chats) {
    const k = startOfDay(c.updatedAt);
    (map.get(k) ?? map.set(k, []).get(k)!).push(c);
  }
  return [...map.keys()]
    .sort((a, b) => b - a)
    .map((k) => ({
      key: String(k),
      label:
        k === today
          ? "Today"
          : k === today - DAY
            ? "Yesterday"
            : new Date(k).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              }),
      chats: map.get(k)!,
    }));
}

function byWeek(chats: Conversation[]): ChatGroup[] {
  const tw = startOfWeek(Date.now());
  const map = new Map<number, Conversation[]>();
  for (const c of chats) {
    const k = startOfWeek(c.updatedAt);
    (map.get(k) ?? map.set(k, []).get(k)!).push(c);
  }
  return [...map.keys()]
    .sort((a, b) => b - a)
    .map((k) => ({
      key: String(k),
      label:
        k === tw
          ? "This week"
          : k === tw - 7 * DAY
            ? "Last week"
            : "Week of " +
              new Date(k).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              }),
      meta: `${map.get(k)!.length}`,
      chats: map.get(k)!,
    }));
}

function byConcept(chats: Conversation[]): ChatGroup[] {
  const map = new Map<string, Conversation[]>();
  const none: Conversation[] = [];
  for (const c of chats) {
    if (c.concepts && c.concepts.length) {
      for (const k of c.concepts) (map.get(k) ?? map.set(k, []).get(k)!).push(c);
    } else none.push(c);
  }
  const groups: ChatGroup[] = [...map.entries()]
    .map(([k, v]) => ({ key: k, label: k, meta: `${v.length}`, chats: v }))
    .sort((a, b) => b.chats.length - a.chats.length || a.label.localeCompare(b.label));
  if (none.length)
    groups.push({ key: "__none", label: "Uncategorized", chats: none });
  return groups;
}

function hotTopics(chats: Conversation[]): ChatGroup[] {
  const map = new Map<string, { chats: Conversation[]; msgs: number }>();
  for (const c of chats) {
    for (const k of c.concepts || []) {
      const e = map.get(k) ?? { chats: [], msgs: 0 };
      e.chats.push(c);
      e.msgs += c.messages?.length || 0;
      map.set(k, e);
    }
  }
  return [...map.entries()]
    .map(([k, e]) => ({
      key: k,
      label: k,
      // rank by how often a topic appears, then by how much was discussed
      score: e.chats.length * 1000 + e.msgs,
      meta: `${e.chats.length} chat${e.chats.length > 1 ? "s" : ""} · ${e.msgs} msgs`,
      chats: e.chats,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ score, ...g }) => {
      void score;
      return g;
    });
}

// ---- Force-directed graph layout (deterministic, dependency-free) ---------

export interface LayoutNode {
  id: string;
  /** Relative size weight (e.g. centrality); larger = more spread. */
  weight?: number;
}
export interface LayoutEdge {
  a: string;
  b: string;
  w?: number;
}

/**
 * Compute 2D positions for a small graph via a simple Fruchterman–Reingold
 * simulation. Deterministic (circle init), fits within [0,width]×[0,height].
 */
export function forceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  width = 800,
  height = 520,
  iterations = 320,
  spread = 1,
): Map<string, { x: number; y: number }> {
  const n = nodes.length;
  const pos = new Map<string, { x: number; y: number; dx: number; dy: number }>();
  const cx = width / 2;
  const cy = height / 2;
  const R = Math.min(width, height) * 0.35;
  nodes.forEach((nd, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2;
    pos.set(nd.id, { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), dx: 0, dy: 0 });
  });
  if (n === 0) return new Map();

  const area = width * height;
  const k = Math.sqrt(area / n) * 0.8 * spread; // ideal distance (spread scales it)
  let temp = width * 0.1;

  for (let it = 0; it < iterations; it++) {
    for (const v of pos.values()) {
      v.dx = 0;
      v.dy = 0;
    }
    // repulsion
    for (let i = 0; i < n; i++) {
      const vi = pos.get(nodes[i].id)!;
      for (let j = i + 1; j < n; j++) {
        const vj = pos.get(nodes[j].id)!;
        let dx = vi.x - vj.x;
        let dy = vi.y - vj.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const rep = (k * k) / dist;
        dx = (dx / dist) * rep;
        dy = (dy / dist) * rep;
        vi.dx += dx;
        vi.dy += dy;
        vj.dx -= dx;
        vj.dy -= dy;
      }
    }
    // attraction along edges
    for (const e of edges) {
      const va = pos.get(e.a);
      const vb = pos.get(e.b);
      if (!va || !vb) continue;
      let dx = va.x - vb.x;
      let dy = va.y - vb.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const att = ((dist * dist) / k) * (e.w ? Math.min(e.w, 3) : 1);
      dx = (dx / dist) * att;
      dy = (dy / dist) * att;
      va.dx -= dx;
      va.dy -= dy;
      vb.dx += dx;
      vb.dy += dy;
    }
    // gravity to center + apply with cooling
    for (const v of pos.values()) {
      v.dx += (cx - v.x) * 0.012;
      v.dy += (cy - v.y) * 0.012;
      const d = Math.hypot(v.dx, v.dy) || 0.01;
      v.x += (v.dx / d) * Math.min(d, temp);
      v.y += (v.dy / d) * Math.min(d, temp);
    }
    temp *= 0.985;
  }

  // normalize into bounds with padding
  const pad = 48;
  const xs = [...pos.values()].map((v) => v.x);
  const ys = [...pos.values()].map((v) => v.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = (width - 2 * pad) / Math.max(1, maxX - minX);
  const sy = (height - 2 * pad) / Math.max(1, maxY - minY);
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, v] of pos)
    out.set(id, { x: pad + (v.x - minX) * sx, y: pad + (v.y - minY) * sy });
  return out;
}

/** Human due-date label with overdue awareness. */
export function dueLabel(ts: number): { text: string; overdue: boolean } {
  const diff = ts - Date.now();
  const overdue = diff < 0;
  const abs = Math.abs(diff);
  const h = 3_600_000;
  const d = 86_400_000;
  let text: string;
  if (abs < h) text = `${Math.max(1, Math.round(abs / 60_000))}m`;
  else if (abs < d) text = `${Math.round(abs / h)}h`;
  else text = `${Math.round(abs / d)}d`;
  return { text: overdue ? `${text} overdue` : `in ${text}`, overdue };
}

/** Roll a timestamp forward by one recurrence step. */
export function nextDue(ts: number, repeat: Repeat): number {
  const d = new Date(ts);
  switch (repeat) {
    case "daily": d.setDate(d.getDate() + 1); break;
    case "weekly": d.setDate(d.getDate() + 7); break;
    case "monthly": d.setMonth(d.getMonth() + 1); break;
    case "yearly": d.setFullYear(d.getFullYear() + 1); break;
    default: return ts;
  }
  return d.getTime();
}

/** All occurrences of a reminder within [from, to] (expands recurrence). */
export function occurrencesInRange(r: Reminder, from: number, to: number, cap = 500): number[] {
  const out: number[] = [];
  if (!r.repeat || r.repeat === "none") {
    if (r.dueAt >= from && r.dueAt <= to) out.push(r.dueAt);
    return out;
  }
  let t = r.dueAt;
  let i = 0;
  while (t < from && i < cap) { t = nextDue(t, r.repeat); i++; }
  while (t <= to && i < cap) { out.push(t); t = nextDue(t, r.repeat); i++; }
  return out;
}

export const REPEAT_LABEL: Record<Repeat, string> = {
  none: "Once",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};
