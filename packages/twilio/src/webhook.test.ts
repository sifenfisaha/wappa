import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { computeTwilioSignature, parseFormBody, readRawBody, verifyTwilioSignature } from './webhook.js';

const AUTH_TOKEN = '12345678901234567890123456789012';
const URL_ = 'https://mycompany.com/webhook';

describe('computeTwilioSignature', () => {
  it('matches a fixture built with node:crypto: url + alphabetically sorted name/value pairs, HMAC-SHA1, base64', () => {
    const params = {
      To: 'whatsapp:+14155238886',
      From: 'whatsapp:+15551234567',
      Body: 'Hello, world!',
      MessageSid: 'SM2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    };
    // Sorted names: Body < From < MessageSid < To — concatenated by hand.
    const data =
      URL_ +
      'Body' + 'Hello, world!' +
      'From' + 'whatsapp:+15551234567' +
      'MessageSid' + 'SM2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' +
      'To' + 'whatsapp:+14155238886';
    const expected = createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
    expect(computeTwilioSignature(AUTH_TOKEN, URL_, params)).toBe(expected);
  });

  it('is independent of parameter insertion order (names are sorted)', () => {
    const a = computeTwilioSignature(AUTH_TOKEN, URL_, { B: '2', A: '1', C: '3' });
    const b = computeTwilioSignature(AUTH_TOKEN, URL_, { C: '3', A: '1', B: '2' });
    expect(a).toBe(b);
  });

  it('covers the URL, the auth token and every value', () => {
    const sig = computeTwilioSignature(AUTH_TOKEN, URL_, { Body: 'hi' });
    expect(computeTwilioSignature(AUTH_TOKEN, `${URL_}?x=1`, { Body: 'hi' })).not.toBe(sig);
    expect(computeTwilioSignature('other-token', URL_, { Body: 'hi' })).not.toBe(sig);
    expect(computeTwilioSignature(AUTH_TOKEN, URL_, { Body: 'ho' })).not.toBe(sig);
  });
});

describe('verifyTwilioSignature', () => {
  const params = { From: 'whatsapp:+15551234567', Body: 'hello' };
  const valid = computeTwilioSignature(AUTH_TOKEN, URL_, params);

  it('accepts the correct signature', () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, URL_, params, valid)).toBe(true);
  });

  it('rejects a signature from a different auth token', () => {
    const forged = computeTwilioSignature('other-token', URL_, params);
    expect(verifyTwilioSignature(AUTH_TOKEN, URL_, params, forged)).toBe(false);
  });

  it('rejects tampered params and a different URL', () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, URL_, { ...params, Body: 'tampered' }, valid)).toBe(false);
    expect(verifyTwilioSignature(AUTH_TOKEN, 'https://mycompany.com/other', params, valid)).toBe(false);
  });

  it('rejects missing, empty, and malformed headers without throwing', () => {
    expect(verifyTwilioSignature(AUTH_TOKEN, URL_, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(AUTH_TOKEN, URL_, params, '')).toBe(false);
    expect(verifyTwilioSignature(AUTH_TOKEN, URL_, params, 'not-base64!!')).toBe(false);
    // Wildly wrong length must not throw (both sides are hashed before compare).
    expect(verifyTwilioSignature(AUTH_TOKEN, URL_, params, 'x')).toBe(false);
  });
});

describe('parseFormBody', () => {
  it('decodes percent-encoding and + as space', () => {
    const params = parseFormBody(Buffer.from('Body=Hello+there%21&From=whatsapp%3A%2B15551234567'));
    expect(params).toEqual({ Body: 'Hello there!', From: 'whatsapp:+15551234567' });
  });

  it('keeps the last value of a repeated name and handles empty bodies', () => {
    expect(parseFormBody(Buffer.from('A=1&A=2&B='))).toEqual({ A: '2', B: '' });
    expect(parseFormBody(Buffer.from(''))).toEqual({});
  });
});

describe('readRawBody', () => {
  /** Minimal stand-in for an IncomingMessage stream. */
  function fakeReq(): IncomingMessage & { destroyed: boolean } {
    const em = new EventEmitter() as IncomingMessage & { destroyed: boolean };
    em.destroyed = false;
    (em as unknown as { destroy: () => void }).destroy = () => {
      em.destroyed = true;
    };
    return em;
  }

  it('concatenates chunks into one Buffer', async () => {
    const req = fakeReq();
    const p = readRawBody(req);
    req.emit('data', Buffer.from('Body=hello'));
    req.emit('data', Buffer.from('+world'));
    req.emit('end');
    expect((await p).toString()).toBe('Body=hello+world');
  });

  it('rejects and destroys the stream when the body exceeds maxBytes', async () => {
    const req = fakeReq();
    const p = readRawBody(req, 4);
    req.emit('data', Buffer.from('12345'));
    await expect(p).rejects.toThrow(/exceeded 4 bytes/);
    expect(req.destroyed).toBe(true);
  });

  it('caps the default body size at 1 MiB (pre-authentication buffering)', async () => {
    const req = fakeReq();
    const p = readRawBody(req);
    req.emit('data', Buffer.alloc(1024 * 1024));
    req.emit('data', Buffer.alloc(1));
    await expect(p).rejects.toThrow(/exceeded 1048576 bytes/);
    expect(req.destroyed).toBe(true);
  });

  it('rejects on stream error', async () => {
    const req = fakeReq();
    const p = readRawBody(req);
    req.emit('error', new Error('boom'));
    await expect(p).rejects.toThrow('boom');
  });
});
