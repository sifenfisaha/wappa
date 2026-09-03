import { afterEach, describe, expect, it, vi } from 'vitest';
import { rateLimit } from './middleware.js';
import { createSession } from './session.js';
import type { Context } from './context.js';
import type { Logger } from './logger.js';
import type { Bot } from './bot.js';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeCtx(chatId: string, logger: Logger = silentLogger): Context {
  return {
    message: {
      id: 'm',
      chatId,
      senderId: chatId,
      timestamp: 0,
      isGroup: false,
      fromMe: false,
      text: 'x',
    },
    bot: {} as Bot,
    session: createSession(),
    state: {},
    reply: async () => ({}),
    sendTyping: async () => {},
    logger,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rateLimit', () => {
  it('allows up to max messages per window, then drops without calling next()', async () => {
    const mw = rateLimit({ windowMs: 1000, max: 2 });
    const next = vi.fn(async () => {});
    const onLimitless = fakeCtx('chat');
    await mw(onLimitless, next);
    await mw(onLimitless, next);
    await mw(onLimitless, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('calls onLimit (awaited) for each dropped message', async () => {
    const dropped: Context[] = [];
    const mw = rateLimit({
      windowMs: 1000,
      max: 1,
      onLimit: async (ctx) => {
        await Promise.resolve();
        dropped.push(ctx);
      },
    });
    const next = vi.fn(async () => {});
    const ctx = fakeCtx('chat');
    await mw(ctx, next);
    await mw(ctx, next);
    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([ctx, ctx]);
  });

  it('resets the fixed window once it elapses', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const mw = rateLimit({ windowMs: 1000, max: 1 });
    const next = vi.fn(async () => {});
    const ctx = fakeCtx('chat');
    await mw(ctx, next);
    await mw(ctx, next); // dropped, same window
    expect(next).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(11_000); // window elapsed exactly
    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('tracks each chat independently', async () => {
    const mw = rateLimit({ windowMs: 1000, max: 1 });
    const next = vi.fn(async () => {});
    await mw(fakeCtx('a'), next);
    await mw(fakeCtx('a'), next); // dropped
    await mw(fakeCtx('b'), next); // separate counter
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('routes onLimit errors to ctx.logger and does not throw', async () => {
    const errorSpy = vi.fn();
    const logger: Logger = { ...silentLogger, error: errorSpy };
    const mw = rateLimit({
      windowMs: 1000,
      max: 0,
      onLimit: () => {
        throw new Error('limit handler broke');
      },
    });
    const next = vi.fn(async () => {});
    await expect(mw(fakeCtx('chat', logger), next)).resolves.toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]![0]).toContain('limit handler broke');
  });

  it('sweeps expired windows once the map grows past the threshold', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(0);
    const mw = rateLimit({ windowMs: 1000, max: 5 });
    const next = vi.fn(async () => {});
    for (let i = 0; i < 1001; i++) await mw(fakeCtx(`chat-${i}`), next);

    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    nowSpy.mockReturnValue(5000); // every existing window has expired
    await mw(fakeCtx('fresh-chat'), next); // insert past the threshold triggers the sweep
    const deletedKeys = deleteSpy.mock.calls.map((c) => c[0] as string);
    expect(deletedKeys).toHaveLength(1001);
    expect(deletedKeys).toContain('chat-0');
    expect(deletedKeys).toContain('chat-1000');
    expect(deletedKeys).not.toContain('fresh-chat');
  });

  it('defaults to 20 messages per 60s window', async () => {
    const mw = rateLimit();
    const next = vi.fn(async () => {});
    const ctx = fakeCtx('chat');
    for (let i = 0; i < 21; i++) await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(20);
  });
});
