/**
 * Generic SSE line parser for `text/event-stream` responses.
 *
 * Usage:
 *   for await (const line of parseSse(res.body!, signal)) {
 *     if (!line.startsWith("data: ")) continue;
 *     const json = JSON.parse(line.slice(6));
 *     ...
 *   }
 *
 * Handles partial chunks across reads, multi-line data fields (SSE spec
 * allows data to be split across multiple `data:` lines), and the
 * `abort` signal so client disconnects terminate the reader.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        // Strip trailing \r if present (CRLF line endings).
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;

        if (trimmed === "") {
          // Blank line = end of event. Emit accumulated data as a single line.
          if (dataLines.length > 0) {
            yield dataLines.join("\n");
            dataLines = [];
          }
          continue;
        }

        if (trimmed.startsWith("data:")) {
          // Per spec: "data:" with optional single space, then the payload.
          const payload = trimmed.slice(5);
          dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
        }
        // Ignore `event:`, `id:`, `retry:` — we don't use them here.
      }
    }

    // Flush any trailing event.
    if (dataLines.length > 0) {
      yield dataLines.join("\n");
    }
  } finally {
    reader.releaseLock();
  }
}
