// Minimal server-side Gemini client. The API key stays here (read from the
// shared .env) and never reaches the browser — this is the "gateway" role from
// idea.md §3. Streams plain text deltas back to the caller.

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export function hasGeminiKey() {
  return !!process.env.GEMINI_API_KEY;
}

/** Map our UI model id to a configured Gemini model name. */
function resolveModel(modelId) {
  if (modelId.includes("flash")) {
    return process.env.GEMINI_RAG_MODEL || "gemini-2.5-flash";
  }
  return process.env.GEMINI_MODEL || "gemini-2.5-pro";
}

/**
 * Stream a Gemini completion. Yields text deltas; reports token usage via onUsage.
 * @param {{model:string, system?:string, messages:{role:string,content:string}[], onUsage?:(u:{input:number,output:number})=>void}} opts
 */
export async function* streamGemini({ model, system, messages, onUsage }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const geminiModel = resolveModel(model);

  const contents = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body = {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      temperature: Number(process.env.GEMINI_TEMPERATURE) || 0.7,
    },
  };

  const url = `${ENDPOINT}/${geminiModel}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastUsage = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        if (json?.usageMetadata) lastUsage = json.usageMetadata;
        const text = json?.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join("");
        if (text) yield text;
      } catch {
        /* partial JSON across chunks — ignore, buffer continues */
      }
    }
  }

  if (onUsage && lastUsage) {
    onUsage({
      input: lastUsage.promptTokenCount || 0,
      output: lastUsage.candidatesTokenCount || 0,
    });
  }
}
