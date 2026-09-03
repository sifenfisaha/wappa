/**
 * echo-bot — the smallest useful wappa bot: no LLM at all.
 *
 * What it shows:
 *   - a router-only Bot (no `agent`) with command() and hears() routes
 *   - koa-style middleware around the built-in router, and ctx.state as
 *     per-message scratch space shared between middleware and handlers
 *   - swapping BaileysTransport for MockTransport in tests
 */
import { Bot, consoleLogger, type Context, type Middleware } from '@wappa/core';
import { BaileysTransport } from '@wappa/baileys';

const logger = consoleLogger();

// Baileys logs in as a *personal* WhatsApp number: the first run prints a QR
// code to scan with your phone, and credentials are cached in ./wappa-auth so
// later runs reconnect silently. Unofficial client — use a number you can
// afford to lose; prefer @wappa/cloud-api for production.
const transport = new BaileysTransport({ authDir: './wappa-auth' });

// In tests, swap the transport for the in-memory mock — nothing else changes:
//
//   import { MockTransport } from '@wappa/core/testing';
//   const transport = new MockTransport();
//   /* after bot.start(): */
//   await transport.receive({ text: '/ping' });          // full pipeline runs
//   console.log(transport.sent);                          // → [{ chatId: 'test-chat', payload: { text: 'pong' } }]

// No `agent` here — router-only bots are valid. When no route matches, the
// built-in router simply does nothing, which is exactly what lets the echo
// middleware below act as the fallback.
const bot = new Bot({ transport, logger });

// Middleware #1: timing. `await next()` runs everything downstream (remaining
// middleware + router + handler), so measuring around it captures the whole
// pipeline. Skipping next() entirely would stop the chain, router included.
const timing: Middleware = async (ctx, next) => {
  const started = Date.now();
  await next();
  ctx.logger.info(`handled in ${Date.now() - started}ms`, { chatId: ctx.message.chatId });
};

// Middleware #2: the echo fallback. It runs the rest of the pipeline first,
// then echoes only if no handler claimed the message. Handlers signal that via
// ctx.state — per-message scratch space that middleware and handlers share
// (unlike ctx.session.data, it is never persisted).
const echo: Middleware = async (ctx, next) => {
  await next();
  if (ctx.state.handled || !ctx.message.text) return; // media/reactions have no text
  await ctx.reply(`You said: ${ctx.message.text}`);
};

bot.use(timing).use(echo);

// Commands match case-insensitively, whole-word: '/ping' matches '/ping' and
// '/ping now' but never '/pingpong'. A missing leading '/' is normalized.
bot.command('/ping', async (ctx) => {
  ctx.state.handled = true;
  await ctx.reply('pong');
});

// hears() with a string is an exact trigger (whole trimmed text, case-
// insensitive — Telegraf-style, NOT a substring match)...
bot.hears('hello', async (ctx) => {
  ctx.state.handled = true;
  await ctx.reply(`Hi ${ctx.message.senderName ?? 'there'}!`);
});

// ...while a RegExp is tested against the raw text, so it can match anywhere.
bot.hears(/\bgood bot\b/i, async (ctx: Context) => {
  ctx.state.handled = true;
  await ctx.reply('Thanks!');
});

bot.on('ready', (info) => logger.info(`echo-bot ready as ${info.selfId ?? 'unknown'}`));

// stop() drains in-flight messages before disconnecting, so Ctrl+C is safe.
process.once('SIGINT', () => void bot.stop().then(() => process.exit(0)));

await bot.start();
