/**
 * Normalized, transport-agnostic message model.
 *
 * Chat and user ids are opaque strings, transport-specific (Baileys JIDs like
 * `123456789@s.whatsapp.net`, Cloud API phone numbers like `15551234567`).
 * Core never parses them.
 */

/** Media kinds supported across transports. */
export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

/** Inbound media. Download is lazy — adapters implement it. */
export interface MediaRef {
  kind: MediaKind;
  download(): Promise<Buffer>;
  mimetype?: string;
  filename?: string;
  /** true for voice notes */
  ptt?: boolean;
}

/** Geographic location attached to a message. */
export interface Location {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/** Reference to a quoted (replied-to) message. */
export interface QuotedRef {
  id: string;
  text?: string;
  senderId?: string;
}

/** A normalized inbound WhatsApp message, produced by transport adapters. */
export interface InboundMessage {
  id: string;
  /** Conversation id — group id or peer id. Replies go here. */
  chatId: string;
  /** Author id. Equals chatId in a DM; the member's id in a group. */
  senderId: string;
  senderName?: string;
  /** ms since epoch */
  timestamp: number;
  isGroup: boolean;
  fromMe: boolean;
  /** Text body, or media caption, or interactive button/list reply title. */
  text?: string;
  media?: MediaRef;
  location?: Location;
  reaction?: { emoji: string; targetMessageId: string };
  quoted?: QuotedRef;
  /** Interactive reply id (Cloud API button_reply/list_reply). Absent on Baileys. */
  buttonId?: string;
  /** Adapter-specific raw event, for escape hatches. */
  raw?: unknown;
}

/** Outbound media payload. */
export interface OutboundMedia {
  kind: MediaKind;
  /** Buffer, or a URL (https:) or local file path — adapter resolves. */
  data: Buffer | string;
  mimetype?: string;
  filename?: string;
  caption?: string;
  ptt?: boolean;
}

/**
 * Quick-reply button. `id` round-trips only on Cloud API (see InboundMessage.buttonId);
 * on Baileys the reply arrives as plain text (the number or title the user typed), so
 * portable routing should match on `title` via hears().
 */
export interface OutboundButton {
  id: string;
  title: string;
}

/** Structured outbound message content. */
export interface OutboundPayload {
  text?: string;
  media?: OutboundMedia;
  location?: Location;
  /**
   * Quick-reply buttons (max 3 — Cloud API limit). Cloud API renders native
   * buttons; Baileys renders a numbered text fallback appended to `text`.
   */
  buttons?: OutboundButton[];
  /** Message id to quote-reply to. Best-effort. */
  replyTo?: string;
}

/** What users pass to send/reply: a plain string or a full payload. */
export type OutboundContent = string | OutboundPayload;

/** Result of a send; `id` is the transport message id when known. */
export interface SendResult {
  id?: string;
}

/** Normalize string -> OutboundPayload. Exported helper used by adapters/tests. */
export function toPayload(content: OutboundContent): OutboundPayload {
  return typeof content === 'string' ? { text: content } : content;
}
