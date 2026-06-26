// Assembles the system prompt fresh on every request: a stable base template
// (cacheable) + the profile persona + the profile's hand-edited user_context,
// followed by a volatile "current date" block placed AFTER the cache breakpoint
// (so the cache prefix stays byte-stable across turns — see prompt-caching).

// ---- Edit the tone in one place -------------------------------------------
export const TONE =
  "Be concise and direct. Lead with the answer, then the supporting detail. " +
  "Skip filler and hedging, and match depth to the question — short for simple " +
  "asks, thorough for hard ones.";

const BASE_TEMPLATE = `You are Claude, an AI assistant made by Anthropic.

${TONE}

Formatting: Default to clear prose. Use headers, bullet lists, or **bold** only when they genuinely help the reader — don't over-structure short answers.

Reasoning: For code, math, or multi-step problems, work through the key steps before giving the result.

Freshness: Your knowledge has a training cutoff and you cannot know today's date or recent events on your own. When an answer depends on current, recent, post-cutoff, or otherwise time-sensitive information, use the web_search tool (and web_fetch to read specific pages) instead of guessing. Cite sources for anything you retrieved from the web.`;

function todayString() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Build the system prompt as an array of blocks. The first (stable) block
 * carries cache_control; the date block is appended after it (volatile).
 * @param {{persona?:string, userContext?:string}} opts
 */
export function buildSystem({ persona, userContext, ltm, stm } = {}) {
  // Stable block (cached): base + persona + curated context + long-term memory.
  let stable = BASE_TEMPLATE;
  if (persona && persona.trim()) {
    stable += `\n\nThis profile's persona / standing instructions:\n${persona.trim()}`;
  }
  if (userContext && userContext.trim()) {
    stable += `\n\n<user_context>\n${userContext.trim()}\n</user_context>`;
  }
  if (ltm && ltm.trim()) {
    stable += `\n\n<long_term_memory>\n${ltm.trim()}\n</long_term_memory>`;
  }
  const blocks = [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
  ];

  // Volatile block (after the cache breakpoint): today's date + short-term memory.
  let volatileText = `Today's date is ${todayString()}.`;
  if (stm && stm.trim()) {
    volatileText += `\n\n<short_term_memory>\n${stm.trim()}\n</short_term_memory>`;
  }
  blocks.push({ type: "text", text: volatileText });
  return blocks;
}
