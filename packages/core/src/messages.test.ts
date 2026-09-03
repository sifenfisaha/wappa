import { describe, expect, it } from 'vitest';
import { toPayload, type OutboundPayload } from './messages.js';

describe('toPayload', () => {
  it('wraps a string into { text }', () => {
    expect(toPayload('hello')).toEqual({ text: 'hello' });
  });

  it('passes a payload object through unchanged (same reference)', () => {
    const payload: OutboundPayload = { text: 'hi', replyTo: 'abc' };
    expect(toPayload(payload)).toBe(payload);
  });

  it('preserves buttons on a payload', () => {
    const payload: OutboundPayload = {
      text: 'Pick one',
      buttons: [
        { id: 'a', title: 'Option A' },
        { id: 'b', title: 'Option B' },
      ],
    };
    const result = toPayload(payload);
    expect(result.buttons).toEqual([
      { id: 'a', title: 'Option A' },
      { id: 'b', title: 'Option B' },
    ]);
  });

  it('preserves media and location payloads', () => {
    const payload: OutboundPayload = {
      media: { kind: 'image', data: 'https://example.com/x.png', caption: 'pic' },
      location: { latitude: 1, longitude: 2 },
    };
    expect(toPayload(payload)).toBe(payload);
  });
});
