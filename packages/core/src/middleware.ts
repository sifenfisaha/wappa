import type { Context } from './context.js';
import type { Middleware } from './bot.js';

/** Options for {@link rateLimit}. */
export interface RateLimitOptions {
  /** Window length in ms. Default 60_000. */
  windowMs?: number;
  /** Max messages per window per chat. Default 20. */
  max?: number;
  /**
   * Called for each dropped message (awaited; errors go to ctx.logger). The return
   * value is ignored — typed loosely so one-liners like `(ctx) => ctx.reply('…')`
   * compile without a `void` cast.
   */
  onLimit?: (ctx: Context) => unknown;
}

/** Map size above which an insert triggers an eviction sweep of expired windows. */
const SWEEP_THRESHOLD = 1000;

/**
 * Fixed-window counter per chat: allows at most `max` messages per `windowMs`; the
 * counter resets when the window elapses. Over-limit messages are dropped — onLimit is
 * called (awaited, errors to ctx.logger) and next() is NOT called. When an insert grows
 * the map past {@link SWEEP_THRESHOLD}, all expired windows are evicted so the per-chat
 * map cannot grow unboundedly over long-running traffic.
 */
export function rateLimit(opts: RateLimitOptions = {}): Middleware {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 20;
  const windows = new Map<string, { count: number; resetAt: number }>();

  return async (ctx, next) => {
    const now = Date.now();
    const chatId = ctx.message.chatId;
    let entry = windows.get(chatId);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      windows.set(chatId, entry);
      if (windows.size > SWEEP_THRESHOLD) {
        for (const [id, e] of windows) {
          if (now >= e.resetAt) windows.delete(id);
        }
      }
    }
    entry.count += 1;
    if (entry.count > max) {
      if (opts.onLimit) {
        try {
          await opts.onLimit(ctx);
        } catch (err) {
          ctx.logger.error(
            `rateLimit onLimit threw: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return;
    }
    await next();
  };
}
