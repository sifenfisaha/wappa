import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BaileysTransport, backoffDelay, ensureAuthDir } from './transport.js';

describe('backoffDelay', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((a) => backoffDelay(a))).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it('honors custom base and cap', () => {
    expect(backoffDelay(0, 500, 2000)).toBe(500);
    expect(backoffDelay(1, 500, 2000)).toBe(1000);
    expect(backoffDelay(3, 500, 2000)).toBe(2000);
  });

  it('clamps negative attempts to the base delay', () => {
    expect(backoffDelay(-3)).toBe(1000);
  });
});

describe('BaileysTransport (offline)', () => {
  it('has the transport name "baileys"', () => {
    expect(new BaileysTransport().name).toBe('baileys');
  });

  it('stop() is idempotent, including before start()', async () => {
    const transport = new BaileysTransport();
    await expect(transport.stop()).resolves.toBeUndefined();
    await expect(transport.stop()).resolves.toBeUndefined();
  });

  it('send/markRead reject while disconnected', async () => {
    const transport = new BaileysTransport();
    await expect(transport.send('1@s.whatsapp.net', 'hi')).rejects.toThrow(/not connected/);
    await expect(transport.markRead('1@s.whatsapp.net', 'MSG1')).rejects.toThrow(/not connected/);
  });

  it('sendTyping resolves silently (debug log) while disconnected/reconnecting', async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = new BaileysTransport({ logger });
    await expect(transport.sendTyping('1@s.whatsapp.net', true)).resolves.toBeUndefined();
    await expect(transport.sendTyping('1@s.whatsapp.net', false)).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/not connected/), expect.anything());
  });
});

describe('ensureAuthDir', () => {
  it.skipIf(process.platform === 'win32')('creates a fresh auth dir with mode 0700', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wappa-auth-'));
    try {
      const dir = join(base, 'auth');
      await ensureAuthDir(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('tightens an existing auth dir to 0700', async () => {
    const base = await mkdtemp(join(tmpdir(), 'wappa-auth-'));
    try {
      const dir = join(base, 'auth');
      await ensureAuthDir(dir);
      await chmod(dir, 0o755); // simulate a dir created at umask defaults
      await ensureAuthDir(dir);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
