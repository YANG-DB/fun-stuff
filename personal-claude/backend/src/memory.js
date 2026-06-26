import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

// Client-side handler for Anthropic's memory tool (memory_20250818). The model
// emits commands (view/create/str_replace/insert/delete/rename) against paths
// under "/memories"; we map those onto a per-profile directory on disk and
// return the documented result strings. All paths are validated to stay inside
// the profile's memory dir (path-traversal protection).

const DATA_DIR =
  process.env.PERSONAL_CLAUDE_DATA_DIR || join(homedir(), ".personal-claude");

export function memoryDir(pid) {
  if (!/^[a-zA-Z0-9_-]+$/.test(pid)) throw new Error("invalid profile id");
  const dir = join(DATA_DIR, "memory", pid);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Map a model path ("/memories/notes.txt") to an absolute path inside base,
// rejecting anything that escapes the base directory.
function safePath(base, modelPath) {
  const rel = String(modelPath || "").replace(/^\/?memories\/?/, "");
  const abs = resolve(base, rel);
  const baseR = resolve(base);
  if (abs !== baseR && !abs.startsWith(baseR + "/")) {
    throw new Error("path escapes memory directory");
  }
  return abs;
}

function listDir(base, abs, modelPath) {
  const lines = [`Here're the files and directories under ${modelPath}:`];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(dir, name);
      const st = statSync(p);
      const rel = "/memories" + p.slice(base.length);
      lines.push(`${st.isDirectory() ? "dir" : st.size + "B"}\t${rel}${st.isDirectory() ? "/" : ""}`);
      if (st.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(abs, 0);
  return lines.join("\n");
}

function withLineNumbers(text) {
  return text
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
    .join("\n");
}

/**
 * Execute one memory command. Returns { content, is_error }.
 * @param {string} base - the profile's memory directory
 * @param {object} input - the tool input ({ command, path, ... })
 */
export function execMemory(base, input) {
  try {
    const cmd = input?.command;
    switch (cmd) {
      case "view": {
        const abs = safePath(base, input.path);
        if (!existsSync(abs))
          return { content: `The path ${input.path} does not exist. Please provide a valid path.` };
        if (statSync(abs).isDirectory())
          return { content: listDir(base, abs, input.path) };
        let text = readFileSync(abs, "utf8");
        if (Array.isArray(input.view_range)) {
          const [a, b] = input.view_range;
          text = text.split("\n").slice(a - 1, b).join("\n");
        }
        return { content: `Here's the content of ${input.path} with line numbers:\n${withLineNumbers(text)}` };
      }
      case "create": {
        const abs = safePath(base, input.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, input.file_text ?? "", "utf8");
        return { content: `File created successfully at: ${input.path}` };
      }
      case "str_replace": {
        const abs = safePath(base, input.path);
        if (!existsSync(abs))
          return { content: `Error: The path ${input.path} does not exist. Please provide a valid path.`, is_error: true };
        const text = readFileSync(abs, "utf8");
        const occ = text.split(input.old_str).length - 1;
        if (occ === 0)
          return { content: `No replacement was performed, old_str \`${input.old_str}\` did not appear verbatim in ${input.path}.`, is_error: true };
        if (occ > 1)
          return { content: `No replacement was performed. Multiple occurrences of old_str \`${input.old_str}\`. Please ensure it is unique.`, is_error: true };
        writeFileSync(abs, text.replace(input.old_str, input.new_str ?? ""), "utf8");
        return { content: "The memory file has been edited." };
      }
      case "insert": {
        const abs = safePath(base, input.path);
        if (!existsSync(abs))
          return { content: `Error: The path ${input.path} does not exist`, is_error: true };
        const lines = readFileSync(abs, "utf8").split("\n");
        const at = Number(input.insert_line);
        if (at < 0 || at > lines.length)
          return { content: `Error: Invalid \`insert_line\` parameter: ${at}. It should be within [0, ${lines.length}]`, is_error: true };
        lines.splice(at, 0, (input.insert_text ?? "").replace(/\n$/, ""));
        writeFileSync(abs, lines.join("\n"), "utf8");
        return { content: `The file ${input.path} has been edited.` };
      }
      case "delete": {
        const abs = safePath(base, input.path);
        if (!existsSync(abs))
          return { content: `Error: The path ${input.path} does not exist`, is_error: true };
        rmSync(abs, { recursive: true, force: true });
        return { content: `Successfully deleted ${input.path}` };
      }
      case "rename": {
        const from = safePath(base, input.old_path);
        const to = safePath(base, input.new_path);
        if (!existsSync(from))
          return { content: `Error: The path ${input.old_path} does not exist`, is_error: true };
        if (existsSync(to))
          return { content: `Error: The destination ${input.new_path} already exists`, is_error: true };
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        return { content: `Successfully renamed ${input.old_path} to ${input.new_path}` };
      }
      default:
        return { content: `Unknown memory command: ${cmd}`, is_error: true };
    }
  } catch (e) {
    return { content: `Error: ${e.message}`, is_error: true };
  }
}
