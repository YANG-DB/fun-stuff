import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Per-profile hand-edited user_context.md, injected into the system prompt.
// Read fresh on every chat request (so /reload-context is effectively automatic).

const DATA_DIR =
  process.env.PERSONAL_CLAUDE_DATA_DIR || join(homedir(), ".personal-claude");
const CTX_DIR = join(DATA_DIR, "context");
mkdirSync(CTX_DIR, { recursive: true });

function ctxPath(pid) {
  if (!/^[a-zA-Z0-9_-]+$/.test(pid)) throw new Error("invalid profile id");
  return join(CTX_DIR, `${pid}.md`);
}

export function readContext(pid) {
  try {
    const p = ctxPath(pid);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  } catch {
    return "";
  }
}

export function writeContext(pid, content) {
  writeFileSync(ctxPath(pid), String(content ?? ""), "utf8");
}
