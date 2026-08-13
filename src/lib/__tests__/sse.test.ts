import { describe, it, expect } from 'vitest';
import { SSEDecoder } from '../sse';

describe('SSEDecoder', () => {
  it('extracts data payloads from a single complete chunk', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"a":1}\ndata: {"a":2}\n')).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  it('does not emit a frame until its line is complete', () => {
    const decoder = new SSEDecoder();

    // Chunk ends mid-payload — nothing is safe to parse yet.
    expect(decoder.push('data: {"content":"hel')).toEqual([]);

    // The rest of the line arrives and completes the frame intact.
    expect(decoder.push('lo"}\n')).toEqual(['{"content":"hello"}']);
  });

  it('reassembles a frame split across many chunks', () => {
    const decoder = new SSEDecoder();
    const payload = '{"choices":[{"delta":{"content":"streamed"}}]}';
    const frame = `data: ${payload}\n`;

    const emitted: string[] = [];
    for (const char of frame) {
      emitted.push(...decoder.push(char));
    }

    expect(emitted).toEqual([payload]);
  });

  it('handles a split directly on the newline boundary', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"a":1}')).toEqual([]);
    expect(decoder.push('\ndata: {"a":2}\n')).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('skips the [DONE] sentinel', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"a":1}\ndata: [DONE]\n')).toEqual(['{"a":1}']);
  });

  it('ignores non-data lines such as comments and blank separators', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push(': keep-alive\n\ndata: {"a":1}\nevent: ping\n')).toEqual([
      '{"a":1}',
    ]);
  });

  it('tolerates CRLF line endings', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"a":1}\r\ndata: {"a":2}\r\n')).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  it('flushes a trailing frame that had no final newline', () => {
    const decoder = new SSEDecoder();
    expect(decoder.push('data: {"a":1}')).toEqual([]);
    expect(decoder.flush()).toEqual(['{"a":1}']);
  });

  it('flushes nothing when the stream ended cleanly', () => {
    const decoder = new SSEDecoder();
    decoder.push('data: {"a":1}\n');
    expect(decoder.flush()).toEqual([]);
  });
});
