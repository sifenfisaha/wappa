import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot } from './bot.js';
import { Agent } from './agent.js';
import { defineTool } from './tool.js';
import { createSession, FileSessionStore, MemorySessionStore } from './session.js';
import { MockTransport, ScriptedProvider } from './testing.js';
import type { Context } from './context.js';
import type { Logger } from './logger.js';
import type { Provider } from './provider.js';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Flush pending microtasks and macrotasks a few times. */
async function tick(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

const tmpDirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wappa-bot-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class TypingMockTransport extends MockTransport {
  readonly typing: Array<{ chatId: string; on: boolean }> = [];
  async sendTyping(chatId: string, on: boolean): Promise<void> {
    this.typing.push({ chatId, on });
  }
}

describe('Bot middleware', () => {
  it('runs middleware in use() order around the router (onion model)', async () => {
    const transport = new MockTransport();
    const log: string[] = [];
    const bot = new Bot({ transport, logger: silentLogger });
    bot
      .use(async (_ctx, next) => {
        log.push('m1-pre');
        await next();
        log.push('m1-post');
      })
      .use(async (_ctx, next) => {
        log.push('m2-pre');
        await next();
        log.push('m2-post');
      })
      .command('/go', () => {
        log.push('handler');
      });
    await bot.start();
    await transport.receive({ text: '/go' });
    expect(log).toEqual(['m1-pre', 'm2-pre', 'handler', 'm2-post', 'm1-post']);
  });

  it('stops the chain (router included) when a middleware does not call next()', async () => {
    const transport = new MockTransport();
    const log: string[] = [];
    const bot = new Bot({ transport, logger: silentLogger });
    bot
      .use(() => {
        log.push('blocker');
      })
      .use(async (_ctx, next) => {
        log.push('unreached');
        await next();
      })
      .command('/go', () => {
        log.push('handler');
      });
    await bot.start();
    await transport.receive({ text: '/go' });
    expect(log).toEqual(['blocker']);
  });

  it('throws "next() called multiple times" on a double next()', async () => {
    const transport = new MockTransport();
    const errors: Error[] = [];
    const bot = new Bot({
      transport,
      logger: silentLogger,
      onError: (err) => errors.push(err),
    });
    bot.use(async (_ctx, next) => {
      await next();
      await next();
    });
    await bot.start();
    await transport.receive({ text: 'x' });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('next() called multiple times');
  });

  it('reports middleware errors to onError with the ctx and still saves the session', async () => {
    const transport = new MockTransport();
    const store = new MemorySessionStore();
    const errors: Array<{ err: Error; ctx?: Context }> = [];
    const bot = new Bot({
      transport,
      sessions: store,
      logger: silentLogger,
      onError: (err, ctx) => errors.push({ err, ctx }),
    });
    bot.use(() => {
      throw new Error('mw boom');
    });
    await bot.start();
    await transport.receive({ text: 'x' });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.err.message).toBe('mw boom');
    expect(errors[0]!.ctx?.message.text).toBe('x');
    const saved = await store.get('test-chat');
    expect(saved).toBeDefined();
    expect(saved!.updatedAt).toBeGreaterThan(0);
  });
});

describe('Bot command routing', () => {
  async function setup() {
    const transport = new MockTransport();
    const bot = new Bot({ transport, logger: silentLogger });
    const hits: Array<{ cmd: string; args: unknown }> = [];
    const record = (cmd: string) => (ctx: Context) => {
      hits.push({ cmd, args: ctx.state.commandArgs });
    };
    return { transport, bot, hits, record };
  }

  it("matches '/reset' and '/reset now' but never '/resetall'", async () => {
    const { transport, bot, hits, record } = await setup();
    bot.command('/reset', record('/reset'));
    await bot.start();
    await transport.receive({ text: '/reset' });
    await transport.receive({ text: '/reset now' });
    await transport.receive({ text: '/resetall' });
    expect(hits).toEqual([
      { cmd: '/reset', args: '' },
      { cmd: '/reset', args: 'now' },
    ]);
  });

  it("normalizes a missing leading '/' at registration", async () => {
    const { transport, bot, hits, record } = await setup();
    bot.command('reset', record('reset'));
    await bot.start();
    await transport.receive({ text: '/reset please' });
    expect(hits).toEqual([{ cmd: 'reset', args: 'please' }]);
  });

  it('does not match bare text without the leading slash', async () => {
    const { transport, bot, hits, record } = await setup();
    bot.command('/reset', record('/reset'));
    await bot.start();
    await transport.receive({ text: 'reset' });
    expect(hits).toEqual([]);
  });

  it('matches case-insensitively and after leading whitespace, preserving arg case', async () => {
    const { transport, bot, hits, record } = await setup();
    bot.command('/Reset', record('/reset'));
    await bot.start();
    await transport.receive({ text: '   /RESET Chat-42  ' });
    expect(hits).toEqual([{ cmd: '/reset', args: 'Chat-42' }]);
  });

  it('runs only the first matching command', async () => {
    const { transport, bot, hits, record } = await setup();
    bot.command('/a', record('first'));
    bot.command('/a', record('second'));
    await bot.start();
    await transport.receive({ text: '/a' });
    expect(hits).toEqual([{ cmd: 'first', args: '' }]);
  });
});

describe('Bot hears routing', () => {
  it('matches a string pattern on the whole trimmed text, case-insensitively', async () => {
    const transport = new MockTransport();
    const bot = new Bot({ transport, logger: silentLogger });
    const hits: string[] = [];
    bot.hears('hello', (ctx) => {
      hits.push(ctx.message.text!);
    });
    await bot.start();
    await transport.receive({ text: '  HeLLo  ' });
    await transport.receive({ text: 'hello there' }); // NOT a substring match
    await transport.receive({ text: 'say hello' });
    expect(hits).toEqual(['  HeLLo  ']);
  });

  it('tests RegExp patterns against the raw text', async () => {
    const transport = new MockTransport();
    const bot = new Bot({ transport, logger: silentLogger });
    const hits: string[] = [];
    bot.hears(/order\s+(\d+)/, (ctx) => {
      hits.push(ctx.message.text!);
    });
    await bot.start();
    await transport.receive({ text: 'my order 42 is late' });
    await transport.receive({ text: 'no digits here' });
    expect(hits).toEqual(['my order 42 is late']);
  });

  it('prefers commands over hears', async () => {
    const transport = new MockTransport();
    const bot = new Bot({ transport, logger: silentLogger });
    const hits: string[] = [];
    bot.hears('/ping', () => {
      hits.push('hears');
    });
    bot.command('/ping', () => {
      hits.push('command');
    });
    await bot.start();
    await transport.receive({ text: '/ping' });
    expect(hits).toEqual(['command']);
  });
});

describe('Bot drop rules', () => {
  it('drops fromMe messages by default, processes them with ignoreFromMe: false', async () => {
    const transport = new MockTransport();
    const seen: string[] = [];
    const bot = new Bot({ transport, logger: silentLogger });
    bot.use((ctx) => {
      seen.push(ctx.message.id);
    });
    await bot.start();
    await transport.receive({ text: 'x', fromMe: true });
    expect(seen).toEqual([]);

    const transport2 = new MockTransport();
    const seen2: string[] = [];
    const bot2 = new Bot({ transport: transport2, logger: silentLogger, ignoreFromMe: false });
    bot2.use((ctx) => {
      seen2.push(ctx.message.id);
    });
    await bot2.start();
    await transport2.receive({ text: 'x', fromMe: true });
    expect(seen2).toEqual(['msg-1']);
  });

  it('drops group messages when ignoreGroups is set', async () => {
    const transport = new MockTransport();
    const seen: boolean[] = [];
    const bot = new Bot({ transport, logger: silentLogger, ignoreGroups: true });
    bot.use((ctx) => {
      seen.push(ctx.message.isGroup);
    });
    await bot.start();
    await transport.receive({ text: 'x', isGroup: true });
    await transport.receive({ text: 'y' });
    expect(seen).toEqual([false]);
  });

  it('drops senders outside allowFrom silently', async () => {
    const transport = new MockTransport();
    const seen: string[] = [];
    const bot = new Bot({ transport, logger: silentLogger, allowFrom: ['friend'] });
    bot.use((ctx) => {
      seen.push(ctx.message.senderId);
    });
    await bot.start();
    await transport.receive({ text: 'x', senderId: 'stranger' });
    await transport.receive({ text: 'y', senderId: 'friend' });
    expect(seen).toEqual(['friend']);
  });
});

describe('Bot agent pipeline', () => {
  it('runs the agent as the default handler and replies with its text', async () => {
    const transport = new MockTransport();
    const provider = new ScriptedProvider(['Hi from the agent!']);
    const store = new MemorySessionStore();
    const bot = new Bot({
      transport,
      sessions: store,
      logger: silentLogger,
      agent: new Agent({ instructions: 'sys', provider }),
    });
    await bot.start();
    await transport.receive({ text: 'hello' });

    expect(transport.sent).toEqual([
      { chatId: 'test-chat', payload: { text: 'Hi from the agent!' } },
    ]);
    const saved = await store.get('test-chat');
    expect(saved!.history).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi from the agent!' },
    ]);
    expect(saved!.updatedAt).toBeGreaterThan(0);
  });

  it('sends the typing indicator around the agent turn (and not when disabled)', async () => {
    const transport = new TypingMockTransport();
    const bot = new Bot({
      transport,
      logger: silentLogger,
      agent: new Agent({ instructions: 'sys', provider: new ScriptedProvider(['yo']) }),
    });
    await bot.start();
    await transport.receive({ text: 'hi' });
    expect(transport.typing).toEqual([
      { chatId: 'test-chat', on: true },
      { chatId: 'test-chat', on: false },
    ]);

    const transport2 = new TypingMockTransport();
    const bot2 = new Bot({
      transport: transport2,
      logger: silentLogger,
      typingIndicator: false,
      agent: new Agent({ instructions: 'sys', provider: new ScriptedProvider(['yo']) }),
    });
    await bot2.start();
    await transport2.receive({ text: 'hi' });
    expect(transport2.typing).toEqual([]);
  });

  it('still runs the agent and replies when sendTyping throws (typing is best-effort)', async () => {
    class BrokenTypingTransport extends MockTransport {
      async sendTyping(): Promise<void> {
        throw new Error('typing broke');
      }
    }
    const transport = new BrokenTypingTransport();
    const errors: Error[] = [];
    const bot = new Bot({
      transport,
      logger: silentLogger,
      onError: (err) => errors.push(err),
      agent: new Agent({ instructions: 'sys', provider: new ScriptedProvider(['still here']) }),
    });
    await bot.start();
    await transport.receive({ text: 'hi' });

    expect(transport.sent.map((s) => s.payload.text)).toEqual(['still here']);
    expect(errors).toEqual([]);
  });

  it('skips routing and the agent for contentless messages, but middleware still runs', async () => {
    const transport = new MockTransport();
    const provider = new ScriptedProvider(['never used']);
    let middlewareRan = false;
    let handlerRan = false;
    const bot = new Bot({
      transport,
      logger: silentLogger,
      agent: new Agent({ instructions: 'sys', provider }),
    });
    bot.use(async (_ctx, next) => {
      middlewareRan = true;
      await next();
    });
    bot.hears(/.*/, () => {
      handlerRan = true;
    });
    await bot.start();
    await transport.receive({ reaction: { emoji: '👍', targetMessageId: 'm0' } });

    expect(middlewareRan).toBe(true);
    expect(handlerRan).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(transport.sent).toEqual([]);
  });

  it('skips router and agent when the session is paused', async () => {
    const transport = new MockTransport();
    const provider = new ScriptedProvider(['never used']);
    const store = new MemorySessionStore();
    const paused = createSession();
    paused.paused = true;
    await store.set('test-chat', paused);
    let commandRan = false;
    const bot = new Bot({
      transport,
      sessions: store,
      logger: silentLogger,
      agent: new Agent({ instructions: 'sys', provider }),
    });
    bot.command('/hi', () => {
      commandRan = true;
    });
    await bot.start();
    await transport.receive({ text: '/hi' });
    await transport.receive({ text: 'talk to me' });

    expect(commandRan).toBe(false);
    expect(provider.calls).toHaveLength(0);
    expect(transport.sent).toEqual([]);
  });
});

describe('Bot pause/resume (lost-update safe)', () => {
  it('pause from within a tool persists with FileSessionStore (regression)', async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    const transport = new MockTransport();
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: 'c1', name: 'escalate', arguments: {} }] },
      'A human will take over.',
      'Back again.',
    ]);
    const escalate = defineTool({
      name: 'escalate',
      description: 'hand off to a human',
      execute: async (_args, ctx) => {
        // The cross-chat-safe form; must hit the live in-flight context path
        // (enqueueing here would deadlock the per-chat queue).
        await ctx.bot.pause(ctx.message.chatId);
        return 'escalated';
      },
    });
    const bot = new Bot({
      transport,
      sessions: store,
      logger: silentLogger,
      agent: new Agent({ instructions: 'sys', provider, tools: [escalate] }),
    });
    await bot.start();

    await transport.receive({ text: 'I need a human' });
    expect(transport.sent.map((s) => s.payload.text)).toEqual(['A human will take over.']);

    // The paused flag must survive the pipeline's own save — the lost update the
    // naive load→mutate→save would cause with a copy-returning store.
    const saved = await store.get('test-chat');
    expect(saved?.paused).toBe(true);
    expect(saved?.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // While paused, the agent is skipped entirely.
    await transport.receive({ text: 'hello?' });
    expect(provider.calls).toHaveLength(2);
    expect(transport.sent).toHaveLength(1);

    // resume() with no in-flight context enqueues a load→mutate→save job.
    await bot.resume('test-chat');
    const resumed = await store.get('test-chat');
    expect(resumed?.paused).toBe(false);
    expect(resumed?.history).toHaveLength(4); // history preserved by resume

    await transport.receive({ text: 'you back?' });
    expect(transport.sent.map((s) => s.payload.text)).toEqual([
      'A human will take over.',
      'Back again.',
    ]);
  });

  it('ctx.session.paused = true inside a handler persists too', async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    const transport = new MockTransport();
    const bot = new Bot({ transport, sessions: store, logger: silentLogger });
    bot.command('/handoff', (ctx) => {
      ctx.session.paused = true;
    });
    await bot.start();
    await transport.receive({ text: '/handoff' });
    expect((await store.get('test-chat'))?.paused).toBe(true);
  });

  it('pause() for an idle chat serializes through the per-chat queue', async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    const transport = new MockTransport();
    const bot = new Bot({ transport, sessions: store, logger: silentLogger });
    await bot.start();
    await bot.pause('idle-chat');
    expect((await store.get('idle-chat'))?.paused).toBe(true);
    await bot.resume('idle-chat');
    expect((await store.get('idle-chat'))?.paused).toBe(false);
  });
});

describe('Bot per-chat queue', () => {
  it('serializes messages within a chat; different chats interleave', async () => {
    const transport = new MockTransport();
    const log: string[] = [];
    const gates = new Map<string, Deferred>();
    const bot = new Bot({ transport, logger: silentLogger });
    bot.use(async (ctx) => {
      const id = ctx.message.text!;
      log.push(`start:${id}`);
      await gates.get(id)?.promise;
      log.push(`end:${id}`);
    });
    await bot.start();

    const gateA1 = deferred();
    gates.set('a1', gateA1);
    const p1 = transport.receive({ chatId: 'chat-A', text: 'a1' });
    const p2 = transport.receive({ chatId: 'chat-A', text: 'a2' });
    const p3 = transport.receive({ chatId: 'chat-B', text: 'b1' });
    await tick();

    // a1 is blocked mid-turn: a2 (same chat) must not have started; b1 (other chat) finished.
    expect(log).toContain('start:a1');
    expect(log).not.toContain('start:a2');
    expect(log).toContain('end:b1');

    gateA1.resolve();
    await Promise.all([p1, p2, p3]);
    const chatA = log.filter((l) => l.endsWith(':a1') || l.endsWith(':a2'));
    expect(chatA).toEqual(['start:a1', 'end:a1', 'start:a2', 'end:a2']);
  });

  it('receive() resolves only after the full pipeline (incl. save) settles', async () => {
    const transport = new MockTransport();
    const store = new MemorySessionStore();
    const provider = new ScriptedProvider(['done']);
    const bot = new Bot({
      transport,
      sessions: store,
      logger: silentLogger,
      agent: new Agent({ instructions: 'sys', provider }),
    });
    await bot.start();
    await transport.receive({ text: 'go' });
    // No extra ticks needed: the session must already be saved.
    expect((await store.get('test-chat'))?.history).toHaveLength(2);
  });
});

describe('Bot lifecycle', () => {
  it('exposes selfId and emits ready', async () => {
    const transport = new MockTransport();
    const bot = new Bot({ transport, logger: silentLogger });
    const readyInfos: Array<{ selfId?: string }> = [];
    bot.on('ready', (info) => readyInfos.push(info));
    await bot.start();
    expect(bot.selfId).toBe('mock');
    expect(readyInfos).toEqual([{ selfId: 'mock' }]);
  });

  it('stop() drains in-flight turns (sessions saved) before stopping the transport', async () => {
    const transport = new MockTransport();
    const stopSpy = vi.spyOn(transport, 'stop');
    const gate = deferred();
    const provider: Provider = {
      name: 'slow',
      generate: async () => {
        await gate.promise;
        return { text: 'late reply', toolCalls: [], finishReason: 'stop' };
      },
    };
    const store = new MemorySessionStore();
    const bot = new Bot({
      transport,
      sessions: store,
      logger: silentLogger,
      agent: new Agent({ instructions: 'sys', provider }),
    });
    await bot.start();

    const receiving = transport.receive({ text: 'hi' });
    await tick(); // let the turn reach the provider
    let stopped = false;
    const stopping = bot.stop().then(() => {
      stopped = true;
    });

    // New inbound while stopping is dropped.
    await transport.receive({ chatId: 'other-chat', text: 'too late' });
    await tick();
    expect(stopped).toBe(false);
    expect(stopSpy).not.toHaveBeenCalled();

    gate.resolve();
    await Promise.all([receiving, stopping]);
    expect(stopped).toBe(true);
    expect(transport.sent.map((s) => s.payload.text)).toEqual(['late reply']);
    expect((await store.get('test-chat'))?.history).toHaveLength(2);
    expect(await store.get('other-chat')).toBeUndefined();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // Idempotent.
    await bot.stop();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('supports proactive sends via bot.send()', async () => {
    const transport = new MockTransport();
    const bot = new Bot({ transport, logger: silentLogger });
    await bot.start();
    await bot.send('op-chat', 'heads up');
    expect(transport.sent).toEqual([{ chatId: 'op-chat', payload: { text: 'heads up' } }]);
  });
});

describe('Bot end-to-end (MockTransport + ScriptedProvider)', () => {
  it('routes commands, falls back to the agent, and supports handoff via commandArgs', async () => {
    const transport = new MockTransport();
    const provider = new ScriptedProvider(['I can help with that.']);
    const store = new MemorySessionStore();
    const bot = new Bot({
      transport,
      sessions: store,
      logger: silentLogger,
      agent: new Agent({ instructions: 'support agent', provider }),
    });
    bot.command('/resume', async (ctx) => {
      const target = ctx.state.commandArgs as string;
      await ctx.bot.resume(target);
      await ctx.reply(`resumed ${target}`);
    });
    await bot.start();

    await bot.pause('customer-1');
    await transport.receive({ chatId: 'operator', text: '/resume customer-1' });
    expect((await store.get('customer-1'))?.paused).toBe(false);
    expect(transport.sent).toEqual([
      { chatId: 'operator', payload: { text: 'resumed customer-1' } },
    ]);

    await transport.receive({ chatId: 'customer-1', text: 'my order is late' });
    expect(transport.sent.at(-1)).toEqual({
      chatId: 'customer-1',
      payload: { text: 'I can help with that.' },
    });
    expect(provider.calls).toHaveLength(1);
  });
});
