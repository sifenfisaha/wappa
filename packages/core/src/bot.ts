import type { InboundMessage, OutboundContent, SendResult } from './messages.js';
import type { Transport } from './transport.js';
import type { Agent } from './agent.js';
import type { Context } from './context.js';
import type { Logger } from './logger.js';
import type { SessionData, SessionStore } from './session.js';
import { createSession, MemorySessionStore } from './session.js';
import { consoleLogger } from './logger.js';

/** Continues the middleware chain; resolves when everything downstream finished. */
export type NextFunction = () => Promise<void>;

/** Koa-style middleware: not calling `next()` stops the chain (router included). */
export type Middleware = (ctx: Context, next: NextFunction) => void | Promise<void>;

/** Terminal route handler for command()/hears(). */
export type Handler = (ctx: Context) => void | Promise<void>;

/** Configuration for {@link Bot}. */
export interface BotOptions {
  transport: Transport;
  /** Default handler when no command/hears route matched. Optional — router-only bots are valid. */
  agent?: Agent;
  /** Default `new MemorySessionStore()`. */
  sessions?: SessionStore;
  /** Default true. */
  ignoreFromMe?: boolean;
  /** Default false. */
  ignoreGroups?: boolean;
  /** Allowlist of senderIds; others are silently dropped. Omit = allow all. */
  allowFrom?: string[];
  /** Default `consoleLogger()`. */
  logger?: Logger;
  /** Called on any pipeline error. Default: logger.error. */
  onError?: (err: Error, ctx?: Context) => void;
  /** Send typing indicator while the agent thinks. Default true. */
  typingIndicator?: boolean;
}

interface CommandRoute {
  /** Normalized: leading '/', lowercased. */
  cmd: string;
  handler: Handler;
}

interface HearsRoute {
  pattern: string | RegExp;
  handler: Handler;
}

type BotEvent = 'ready' | 'error' | 'disconnect';

/** Coerce any thrown value into an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** Test a RegExp without leaking lastIndex state across messages. */
function testRegExp(re: RegExp, text: string): boolean {
  if (re.global || re.sticky) re.lastIndex = 0;
  return re.test(text);
}

/**
 * The message pipeline: wires a Transport to middleware, command/hears routing, and an
 * optional Agent, with per-chat sequential processing and session persistence.
 */
export class Bot {
  readonly transport: Transport;
  /** Self id once known (transport onReady). */
  selfId?: string;

  private readonly agent: Agent | undefined;
  private readonly sessions: SessionStore;
  private readonly ignoreFromMe: boolean;
  private readonly ignoreGroups: boolean;
  private readonly allowFrom: Set<string> | undefined;
  private readonly logger: Logger;
  private readonly onErrorFn: (err: Error, ctx?: Context) => void;
  private readonly typingIndicator: boolean;

  private readonly middlewares: Middleware[] = [];
  private readonly commands: CommandRoute[] = [];
  private readonly hearsRoutes: HearsRoute[] = [];
  private readonly listeners: Record<BotEvent, Array<(...args: never[]) => void>> = {
    ready: [],
    error: [],
    disconnect: [],
  };

  /** Per-chat promise chains: messages within one chat run strictly sequentially. */
  private readonly queues = new Map<string, Promise<void>>();
  /** Live in-flight Context per chat, registered while its pipeline runs (incl. save). */
  private readonly inflight = new Map<string, Context>();
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(opts: BotOptions) {
    this.transport = opts.transport;
    this.agent = opts.agent;
    this.sessions = opts.sessions ?? new MemorySessionStore();
    this.ignoreFromMe = opts.ignoreFromMe ?? true;
    this.ignoreGroups = opts.ignoreGroups ?? false;
    this.allowFrom = opts.allowFrom ? new Set(opts.allowFrom) : undefined;
    this.logger = opts.logger ?? consoleLogger();
    this.onErrorFn =
      opts.onError ?? ((err) => this.logger.error(`pipeline error: ${err.message}`, { err }));
    this.typingIndicator = opts.typingIndicator ?? true;
  }

  /** Append a middleware; runs in registration order around the built-in router. */
  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  /**
   * Command routing. A missing leading '/' is normalized ('reset' === '/reset').
   * Match rule (case-insensitive, after trimming leading whitespace): the text equals
   * the command, or starts with the command followed by whitespace — '/reset' matches
   * '/reset' and '/reset now', NEVER '/resetall'. Before invoking the handler the
   * router sets ctx.state.commandArgs to the trimmed remainder ('' if none).
   */
  command(cmd: string, handler: Handler): this {
    const trimmed = cmd.trim();
    const normalized = (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).toLowerCase();
    this.commands.push({ cmd: normalized, handler });
    return this;
  }

  /**
   * String pattern: matches when the whole trimmed text equals it case-insensitively
   * (exact trigger, Telegraf-style — NOT substring). RegExp: tested against the raw text.
   */
  hears(pattern: string | RegExp, handler: Handler): this {
    this.hearsRoutes.push({ pattern, handler });
    return this;
  }

  /** Lifecycle events only — message handling belongs to use()/command()/hears()/agent. */
  on(event: 'ready', l: (info: { selfId?: string }) => void): this;
  on(event: 'error', l: (err: Error) => void): this;
  on(event: 'disconnect', l: (reason?: string) => void): this;
  on(event: BotEvent, l: (...args: never[]) => void): this {
    this.listeners[event].push(l);
    return this;
  }

  private emit(event: BotEvent, ...args: unknown[]): void {
    const listeners = this.listeners[event];
    if (event === 'error' && listeners.length === 0) {
      const err = args[0] as Error;
      this.logger.error(`transport error: ${err.message}`, { err });
      return;
    }
    for (const listener of listeners) {
      try {
        (listener as (...a: unknown[]) => void)(...args);
      } catch (err) {
        this.logger.error(`'${event}' listener threw: ${toError(err).message}`);
      }
    }
  }

  /** Start the transport and begin processing inbound messages. */
  async start(): Promise<void> {
    this.stopping = false;
    this.stopPromise = undefined;
    await this.transport.start({
      onMessage: (msg) => this.handleInbound(msg),
      onReady: (info) => {
        this.selfId = info.selfId;
        this.emit('ready', info);
      },
      onError: (err) => this.emit('error', err),
      onDisconnect: (reason) => this.emit('disconnect', reason),
    });
  }

  /**
   * Graceful shutdown: stop enqueueing new inbound messages (drop them), await all
   * per-chat queues to drain (in-flight turns finish and their sessions save), then
   * transport.stop(). Idempotent.
   */
  async stop(): Promise<void> {
    if (!this.stopPromise) {
      this.stopping = true;
      this.stopPromise = (async () => {
        while (this.queues.size > 0) {
          await Promise.all([...this.queues.values()]);
        }
        await this.transport.stop();
      })();
    }
    return this.stopPromise;
  }

  /** Proactive send, usable any time after start. */
  send(chatId: string, content: OutboundContent): Promise<SendResult> {
    return this.transport.send(chatId, content);
  }

  /** Human handoff: pause the agent for one chat (persisted in session). */
  pause(chatId: string): Promise<void> {
    return this.setPaused(chatId, true);
  }

  /** Resume the agent for one chat (persisted in session). */
  resume(chatId: string): Promise<void> {
    return this.setPaused(chatId, false);
  }

  /**
   * Lost-update-safe pause/resume: when the chat has a live in-flight Context, mutate
   * that context's session directly (the pipeline's own save persists it) — never
   * enqueue, since the current turn holds the per-chat queue (deadlock). Otherwise,
   * enqueue a load→mutate→save job on the per-chat queue so it serializes with
   * message processing.
   */
  private setPaused(chatId: string, paused: boolean): Promise<void> {
    const live = this.inflight.get(chatId);
    if (live) {
      live.session.paused = paused;
      return Promise.resolve();
    }
    return this.enqueue(chatId, async () => {
      const session = (await this.sessions.get(chatId)) ?? createSession();
      session.paused = paused;
      session.updatedAt = Date.now();
      await this.sessions.set(chatId, session);
    });
  }

  /**
   * Chain a job onto the chat's per-chat queue. Returns the job's own promise (so the
   * caller observes its result); the stored queue tail never rejects, and the queue
   * entry is pruned once it drains.
   */
  private enqueue(chatId: string, job: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const run = prev.then(job);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(chatId, tail);
    void tail.then(() => {
      if (this.queues.get(chatId) === tail) this.queues.delete(chatId);
    });
    return run;
  }

  /**
   * Transport entry point. Returns a promise that resolves when this message's queue
   * turn fully completes (pipeline + session save) — MockTransport.receive awaits it.
   */
  private handleInbound(msg: InboundMessage): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (msg.fromMe && this.ignoreFromMe) return Promise.resolve();
    if (msg.isGroup && this.ignoreGroups) return Promise.resolve();
    if (this.allowFrom && !this.allowFrom.has(msg.senderId)) return Promise.resolve();
    return this.enqueue(msg.chatId, () => this.processMessage(msg));
  }

  /** One full pipeline run for one message. Never rejects — errors go to onError. */
  private async processMessage(msg: InboundMessage): Promise<void> {
    let ctx: Context | undefined;
    try {
      const session = (await this.sessions.get(msg.chatId)) ?? createSession();
      ctx = this.buildContext(msg, session);
      this.inflight.set(msg.chatId, ctx);

      let chainError: unknown;
      let chainFailed = false;
      try {
        await this.runChain(ctx);
      } catch (err) {
        chainError = err;
        chainFailed = true;
      }

      // Save even when the chain errored — the session was loaded.
      session.updatedAt = Date.now();
      try {
        await this.sessions.set(msg.chatId, session);
      } catch (err) {
        this.reportError(err, ctx);
      }
      this.inflight.delete(msg.chatId);

      if (chainFailed) this.reportError(chainError, ctx);
    } catch (err) {
      this.inflight.delete(msg.chatId);
      this.reportError(err, ctx);
    }
  }

  private reportError(err: unknown, ctx?: Context): void {
    try {
      this.onErrorFn(toError(err), ctx);
    } catch (handlerErr) {
      this.logger.error(`onError handler threw: ${toError(handlerErr).message}`);
    }
  }

  private buildContext(msg: InboundMessage, session: SessionData): Context {
    return {
      message: msg,
      bot: this,
      session,
      state: {},
      logger: this.logger,
      reply: (content) => this.transport.send(msg.chatId, content),
      sendTyping: async (on = true) => {
        if (this.transport.sendTyping) await this.transport.sendTyping(msg.chatId, on);
      },
    };
  }

  /** Run the middleware chain (use order); the innermost handler is the built-in router. */
  private runChain(ctx: Context): Promise<void> {
    const stack: Middleware[] = [...this.middlewares, (c) => this.route(c)];
    let index = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      const fn = stack[i];
      if (!fn) return;
      await fn(ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  }

  /** Built-in router: paused check, contentless skip, command/hears routes, then agent. */
  private async route(ctx: Context): Promise<void> {
    if (ctx.session.paused) return;

    const text = ctx.message.text;
    if (!text) return;

    const trimmedStart = text.replace(/^\s+/u, '');
    const lower = trimmedStart.toLowerCase();
    for (const { cmd, handler } of this.commands) {
      let commandArgs: string | undefined;
      if (lower === cmd) {
        commandArgs = '';
      } else if (lower.startsWith(cmd) && /\s/u.test(trimmedStart.charAt(cmd.length))) {
        commandArgs = trimmedStart.slice(cmd.length).trim();
      }
      if (commandArgs !== undefined) {
        ctx.state.commandArgs = commandArgs;
        await handler(ctx);
        return;
      }
    }

    const exact = text.trim().toLowerCase();
    for (const { pattern, handler } of this.hearsRoutes) {
      const matched =
        typeof pattern === 'string'
          ? exact === pattern.toLowerCase()
          : testRegExp(pattern, text);
      if (matched) {
        await handler(ctx);
        return;
      }
    }

    if (!this.agent) return;
    try {
      if (this.typingIndicator) {
        try {
          await ctx.sendTyping(true);
        } catch (err) {
          // Typing is best-effort — a transport typing failure must not abort the turn.
          this.logger.debug(`sendTyping failed: ${toError(err).message}`);
        }
      }
      const reply = await this.agent.run(ctx);
      if (reply) await ctx.reply(reply);
    } finally {
      if (this.typingIndicator) {
        try {
          await ctx.sendTyping(false);
        } catch {
          // ignored — typing teardown is best-effort
        }
      }
    }
  }
}
