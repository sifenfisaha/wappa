import type { InboundMessage, OutboundContent, SendResult } from './messages.js';
import type { SessionData } from './session.js';
import type { Logger } from './logger.js';
import type { Bot } from './bot.js';

/**
 * Per-message context passed to middleware, route handlers, tools, and the agent.
 * Built by the Bot for every inbound message.
 */
export interface Context {
  message: InboundMessage;
  bot: Bot;
  /** Loaded session — mutate freely; Bot saves it after the pipeline finishes. */
  session: SessionData;
  /**
   * Per-message scratch space for middleware. Not persisted — durable data belongs in
   * ctx.session.data. The router sets ctx.state.commandArgs (string) before invoking a
   * command handler.
   */
  state: Record<string, unknown>;
  /** Send to message.chatId. */
  reply(content: OutboundContent): Promise<SendResult>;
  /** Typing indicator; no-op if unsupported by the transport; default on=true. */
  sendTyping(on?: boolean): Promise<void>;
  logger: Logger;
}
