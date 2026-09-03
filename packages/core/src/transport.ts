import type { InboundMessage, OutboundContent, SendResult } from './messages.js';

/** Event callbacks a Bot registers with a transport via {@link Transport.start}. */
export interface TransportHandlers {
  onMessage(msg: InboundMessage): void | Promise<void>;
  onReady?(info: { selfId?: string }): void;
  onError?(err: Error): void;
  onDisconnect?(reason?: string): void;
}

/** A pluggable WhatsApp connection. Adapters translate to/from the normalized model. */
export interface Transport {
  readonly name: string;
  /**
   * Start the transport and begin delivering events. Adapters may resolve before
   * authentication completes (e.g. Baileys resolves during the QR flow) — see adapter docs.
   */
  start(handlers: TransportHandlers): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, content: OutboundContent): Promise<SendResult>;
  /** Optional capabilities — Bot feature-detects by presence. */
  sendTyping?(chatId: string, on: boolean): Promise<void>;
  markRead?(chatId: string, messageId: string): Promise<void>;
}
