import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { memoryDir } from "./memory.js";

// Two layered memory files per profile, kept in the profile's memory dir:
//   STM.md — short-term: frequently regenerated from recent chats/tasks (time-relevant)
//   LTM.md — long-term: incrementally consolidated durable interests/ideas/projects

export const STM_FILE = "STM.md";
export const LTM_FILE = "LTM.md";
export const DETAILS_FILE = "details.json";

function filePath(pid, name) {
  return join(memoryDir(pid), name);
}

export function readMemFile(pid, name) {
  try {
    const f = filePath(pid, name);
    if (!existsSync(f)) return { content: "", updatedAt: 0 };
    return { content: readFileSync(f, "utf8"), updatedAt: statSync(f).mtimeMs };
  } catch {
    return { content: "", updatedAt: 0 };
  }
}

export function writeMemFile(pid, name, content) {
  writeFileSync(filePath(pid, name), String(content ?? ""), "utf8");
}

// Structured personal details (name, websites, social accounts, …) the profile
// curates about themselves; rendered into the LTM file so it's always in context.
export function readDetails(pid) {
  try {
    const f = filePath(pid, DETAILS_FILE);
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

export function writeDetails(pid, obj) {
  writeFileSync(filePath(pid, DETAILS_FILE), JSON.stringify(obj ?? {}, null, 2), "utf8");
}

// Per-conversation digest: the STM/LTM-relevant result for one conversation,
// saved as its own JSON file (staged for later sync to durable storage).
export function writeDigest(pid, cid, obj) {
  try {
    const dir = join(memoryDir(pid), "digests");
    mkdirSync(dir, { recursive: true });
    const safe = String(cid).replace(/[^a-zA-Z0-9_-]/g, "_");
    writeFileSync(
      join(dir, `${safe}.json`),
      JSON.stringify({ ...obj, savedAt: Date.now() }, null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

// Per-conversation metadata (subject/summary/topics) saved as its own JSON file,
// staged under memory/<pid>/conversations/<cid>.json for later sync to storage.
export function writeConvMeta(pid, cid, obj) {
  try {
    const dir = join(memoryDir(pid), "conversations");
    mkdirSync(dir, { recursive: true });
    const safe = String(cid).replace(/[^a-zA-Z0-9_-]/g, "_");
    writeFileSync(
      join(dir, `${safe}.json`),
      JSON.stringify({ id: cid, ...obj, savedAt: Date.now() }, null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}
