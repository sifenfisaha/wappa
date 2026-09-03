import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { computeSignature, readRawBody, verifySignature } from './webhook.js';

const SECRET = 'test-app-secret';

describe('computeSignature', () => {
  it('produces sha256=<hex hmac> of the raw bytes', () => {
    const sig = computeSignature(SECRET, Buffer.from('{"a":1}'));
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Deterministic: same input, same output; different input, different output.
    expect(computeSignature(SECRET, Buffer.from('{"a":1}'))).toBe(sig);
    expect(computeSignature(SECRET, Buffer.from('{"a":2}'))).not.toBe(sig);
  });
});

describe('verifySignature', () => {
  const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));

  it('accepts the correct signature', () => {
    expect(verifySignature(SECRET, body, computeSignature(SECRET, body))).toBe(true);
  });

  it('rejects a signature from a different secret', () => {
    expect(verifySignature(SECRET, body, computeSignature('other-secret', body))).toBe(false);
  });

  it('rejects a tampered body', () => {
    const sig = computeSignature(SECRET, body);
    expect(verifySignature(SECRET, Buffer.concat([body, Buffer.from(' ')]), sig)).toBe(false);
  });

  it('rejects missing, empty, and malformed headers without throwing', () => {
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
    expect(verifySignature(SECRET, body, '')).toBe(false);
    expect(verifySignature(SECRET, body, 'sha256=nothex')).toBe(false);
    expect(verifySignature(SECRET, body, 'sha1=abcdef')).toBe(false);
    // Wildly wrong length must not throw (both sides are hashed before compare).
    expect(verifySignature(SECRET, body, 'x')).toBe(false);
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
    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');
    expect((await p).toString()).toBe('hello world');
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
