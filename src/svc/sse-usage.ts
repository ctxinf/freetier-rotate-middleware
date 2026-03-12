import type { Usage } from "./quota.js";

type SseEvent = {
  data: string[];
};

export async function collectUsageFromSse(body: ReadableStream<Uint8Array>): Promise<Usage | undefined> {
  const reader = body.getReader();
  let buf = "";
  let usage: Usage | undefined;
  const decoder = new TextDecoder();

  const feedEvent = (evt: SseEvent) => {
    for (const line of evt.data) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "[DONE]") return;
      try {
        const obj = JSON.parse(trimmed);
        const u = obj?.usage;
        if (u && typeof u === "object") {
          usage = {
            prompt_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : usage?.prompt_tokens,
            completion_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : usage?.completion_tokens,
            total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : usage?.total_tokens
          };
        }
      } catch {
        // Ignore non-JSON data lines.
      }
    }
  };

  const nextSeparator = (): { idx: number; sepLen: number } | null => {
    const a = buf.indexOf("\r\n\r\n");
    const b = buf.indexOf("\n\n");
    if (a < 0 && b < 0) return null;
    if (a >= 0 && (b < 0 || a < b)) return { idx: a, sepLen: 4 };
    return { idx: b, sepLen: 2 };
  };

  const parseBuffer = () => {
    while (true) {
      const sep = nextSeparator();
      if (!sep) break;
      const raw = buf.slice(0, sep.idx);
      buf = buf.slice(sep.idx + sep.sepLen);

      const lines = raw.split(/\r?\n/);
      const evt: SseEvent = { data: [] };
      for (const l of lines) {
        if (l.startsWith("data:")) evt.data.push(l.slice(5).trimStart());
      }
      feedEvent(evt);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    parseBuffer();
  }

  return usage;
}
