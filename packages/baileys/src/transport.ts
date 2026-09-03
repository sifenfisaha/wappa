/**
 * BaileysTransport — wappa Transport adapter over the unofficial Baileys
 * WhatsApp Web client (personal-number login via QR).
 *
 * Legal note: Baileys is an unofficial client; using it may violate WhatsApp's
 * ToS and can get numbers banned. Use a number you can afford to lose and
 * prefer the Cloud API transport for production.
 */
import { chmod, mkdir } from 'node:fs/promises';
import { consoleLogger, toPayload } from '@wappa/core';
import type {
  Logger,
  OutboundContent,
  SendResult,
  Transport,
  TransportHandlers,
} from '@wappa/core';
import {
  DisconnectReason,
  downloadMediaMessage,
  makeWASocket,
  useMultiFileAuthState,
} from 'baileys';
import type { ConnectionState, WAMessage, WASocket } from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { mapMessage, toBaileysContent } from './mapping.js';

/** Options for {@link BaileysTransport}. */
export interface BaileysTransportOptions {
  /** Directory for multi-file auth state. Default './wappa-auth'. */
  authDir?: string;
  /** Print QR to terminal on login. Default true. */
  printQR?: boolean;
  /** Called with the raw QR string (for custom rendering). */
  onQR?: (qr: string) => void;
  /** wappa logger for adapter logs. Default consoleLogger(). */
  logger?: Logger;
  /** Baileys' own log level. Default 'silent'. */
  baileysLogLevel?: string;
}

/** Base reconnect delay (1s), doubling per attempt. */
const BACKOFF_BASE_MS = 1000;
/** Reconnect delay cap (30s). */
const BACKOFF_MAX_MS = 30_000;

/**
 * Capped exponential backoff: `min(baseMs * 2^attempt, maxMs)`.
 * Attempt 0 → 1s, 1 → 2s, 2 → 4s, ... capped at 30s.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number = BACKOFF_BASE_MS,
  maxMs: number = BACKOFF_MAX_MS
): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}

/** Shape of @hapi/boom errors carried on Baileys disconnects (structural — no boom dep). */
interface BoomLike {
  output?: { statusCode?: number };
}

/** Coerce any thrown value into an Error. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Create the Baileys auth dir with owner-only permissions (0o700) and tighten an
 * existing dir to the same. creds.json is full account-takeover material, so it
 * must never be world-readable on shared hosts.
 */
export async function ensureAuthDir(authDir: string): Promise<void> {
  await mkdir(authDir, { recursive: true, mode: 0o700 });
  await chmod(authDir, 0o700);
}

/**
 * Baileys transport: QR/multi-file-auth login, automatic reconnect with capped
 * exponential backoff (never after `loggedOut`), and mapping between Baileys
 * wire shapes and the wappa message model.
 *
 * `start()` resolves once the socket is created — NOT once logged in — and the
 * QR flow keeps running afterwards: scan the printed QR (or handle `onQR`) and
 * `onReady` fires when the connection opens.
 *
 * `send()` while disconnected/reconnecting rejects with an Error — there is no
 * internal outbound queueing in v0.1; callers observe failures via onError.
 */
export class BaileysTransport implements Transport {
  readonly name = 'baileys' as const;

  private readonly authDir: string;
  private readonly printQR: boolean;
  private readonly onQRCallback: ((qr: string) => void) | undefined;
  private readonly logger: Logger;
  private readonly baileysLogger: pino.Logger;

  private handlers: TransportHandlers | undefined;
  private sock: WASocket | undefined;
  private connected = false;
  private started = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(opts: BaileysTransportOptions = {}) {
    this.authDir = opts.authDir ?? './wappa-auth';
    this.printQR = opts.printQR ?? true;
    this.onQRCallback = opts.onQR;
    this.logger = opts.logger ?? consoleLogger();
    this.baileysLogger = pino({ level: opts.baileysLogLevel ?? 'silent' });
  }

  /**
   * Load the multi-file auth state, create the socket and wire events. Resolves
   * when the socket is created (before authentication completes) but keeps
   * working through the QR flow — `onReady` fires on connection open.
   */
  async start(handlers: TransportHandlers): Promise<void> {
    if (this.started && !this.stopped) {
      throw new Error('BaileysTransport: already started');
    }
    this.started = true;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.handlers = handlers;
    await this.connect();
  }

  /**
   * Close the socket without logging out (auth state is kept for the next
   * start). Idempotent; cancels any pending reconnect.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const sock = this.sock;
    this.sock = undefined;
    if (sock) {
      try {
        await sock.end(undefined);
      } catch (err) {
        this.logger.debug(`baileys socket end failed: ${toError(err).message}`);
      }
    }
  }

  /**
   * Send a normalized outbound payload to a chat. Rejects while
   * disconnected/reconnecting (no outbound queueing in v0.1). `replyTo` is
   * skipped: Baileys quoting requires the original WAMessage, which is not
   * cheaply available — the message is sent unquoted rather than failing.
   */
  async send(chatId: string, content: OutboundContent): Promise<SendResult> {
    const sock = this.requireSocket();
    const payload = toPayload(content);
    if (payload.replyTo) {
      this.logger.debug('replyTo ignored: Baileys quoting needs the original message', {
        chatId,
        replyTo: payload.replyTo,
      });
    }
    const sent = await sock.sendMessage(chatId, toBaileysContent(payload));
    const id = sent?.key?.id;
    return id ? { id } : {};
  }

  /**
   * Typing indicator via presence: `composing` on, `paused` off. Best-effort:
   * returns silently (debug log) when there is no connected socket — e.g. mid
   * reconnect — so a typing indicator never kills an agent turn that would have
   * succeeded after the reconnect (`send()` still throws while disconnected).
   */
  async sendTyping(chatId: string, on: boolean): Promise<void> {
    const sock = this.sock;
    if (!sock || !this.connected) {
      this.logger.debug('sendTyping skipped: not connected', { chatId, on });
      return;
    }
    await sock.sendPresenceUpdate(on ? 'composing' : 'paused', chatId);
  }

  /** Mark one message read via Baileys `readMessages`. */
  async markRead(chatId: string, messageId: string): Promise<void> {
    const sock = this.requireSocket();
    await sock.readMessages([{ remoteJid: chatId, id: messageId, fromMe: false }]);
  }

  private requireSocket(): WASocket {
    if (!this.sock || !this.connected) {
      throw new Error('BaileysTransport: not connected');
    }
    return this.sock;
  }

  /** Create a socket against the stored auth state and wire all events. */
  private async connect(): Promise<void> {
    await ensureAuthDir(this.authDir);
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    if (this.stopped) return;

    const sock = makeWASocket({ auth: state, logger: this.baileysLogger });
    this.sock = sock;

    sock.ev.on('creds.update', () => {
      saveCreds().catch((err: unknown) => {
        this.logger.warn(`failed to persist baileys credentials: ${toError(err).message}`);
      });
    });

    sock.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));

    sock.ev.on('messages.upsert', (upsert) => {
      if (upsert.type !== 'notify') return;
      for (const msg of upsert.messages) this.deliver(msg);
    });

    if (this.stopped) {
      // stop() raced the socket creation — tear the fresh socket down.
      this.sock = undefined;
      void sock.end(undefined).catch(() => undefined);
    }
  }

  private handleConnectionUpdate(update: Partial<ConnectionState>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      if (this.printQR) qrcode.generate(qr, { small: true });
      this.onQRCallback?.(qr);
    }

    if (connection === 'open') {
      this.connected = true;
      this.reconnectAttempt = 0;
      const selfId = this.sock?.user?.id;
      this.logger.info('baileys connection open', selfId ? { selfId } : undefined);
      this.handlers?.onReady?.(selfId ? { selfId } : {});
      return;
    }

    if (connection === 'close') {
      this.connected = false;
      if (this.stopped) return;
      const statusCode = (lastDisconnect?.error as BoomLike | undefined)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        this.logger.warn('baileys logged out — not reconnecting; delete the auth dir to relink');
        this.handlers?.onDisconnect?.('loggedOut');
        return;
      }
      const delay = backoffDelay(this.reconnectAttempt++);
      this.logger.warn(
        `baileys connection closed (status ${statusCode ?? 'unknown'}); reconnecting in ${delay}ms`
      );
      this.scheduleReconnect(delay);
    }
  }

  private scheduleReconnect(delay: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopped) return;
      this.connect().catch((err: unknown) => {
        this.handlers?.onError?.(toError(err));
        if (!this.stopped) this.scheduleReconnect(backoffDelay(this.reconnectAttempt++));
      });
    }, delay);
  }

  /** Map one upserted message and hand it to the Bot; errors go to onError. */
  private deliver(msg: WAMessage): void {
    try {
      const mapped = mapMessage(msg, (m) => this.downloadMedia(m));
      if (!mapped) return;
      Promise.resolve(this.handlers?.onMessage(mapped)).catch((err: unknown) => {
        this.handlers?.onError?.(toError(err));
      });
    } catch (err) {
      this.handlers?.onError?.(toError(err));
    }
  }

  /** Lazy media download used by mapped MediaRefs. */
  private downloadMedia(msg: WAMessage): Promise<Buffer> {
    const sock = this.sock;
    return downloadMediaMessage(
      msg,
      'buffer',
      {},
      sock
        ? { reuploadRequest: sock.updateMediaMessage, logger: this.baileysLogger }
        : undefined
    );
  }
}
