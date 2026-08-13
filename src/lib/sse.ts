/**
 * Incremental decoder for Server-Sent Event streams.
 *
 * Network chunks do not align with SSE frame boundaries — a single `data:` line
 * is routinely split across two reads. Parsing each chunk in isolation silently
 * drops whichever frame straddled the boundary, so this buffers the trailing
 * partial line and only emits complete ones.
 */
export class SSEDecoder {
  private buffer = '';

  /**
   * Feed one decoded chunk of the stream.
   * @returns the `data:` payloads completed by this chunk, excluding `[DONE]`.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is either an incomplete line or '' when the chunk ended
    // exactly on a newline. Either way it is held back until more data arrives.
    this.buffer = lines.pop() ?? '';
    return SSEDecoder.collect(lines);
  }

  /**
   * Emit any payload left buffered when the stream ends without a trailing
   * newline. Streams that end cleanly return nothing here.
   */
  flush(): string[] {
    const remainder = this.buffer;
    this.buffer = '';
    return remainder ? SSEDecoder.collect([remainder]) : [];
  }

  private static collect(lines: string[]): string[] {
    const payloads: string[] = [];
    for (const rawLine of lines) {
      // Tolerate CRLF line endings, which the SSE spec permits.
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line.startsWith('data: ')) continue;

      const data = line.slice(6);
      if (data === '[DONE]') continue;

      payloads.push(data);
    }
    return payloads;
  }
}
