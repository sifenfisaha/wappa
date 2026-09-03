/**
 * Pure mapping functions between Baileys wire shapes and the wappa message model.
 *
 * Everything in this module is side-effect free and imports baileys types only
 * (type-only imports are erased at runtime), so it is unit-testable with plain
 * fixture objects — no socket, no network.
 */
import type {
  InboundMessage,
  MediaKind,
  MediaRef,
  OutboundButton,
  OutboundPayload,
  QuotedRef,
} from '@wappa/core';
import type { AnyMessageContent, WAMediaUpload, WAMessage, proto } from 'baileys';

/** Downloads the media of a Baileys message as a Buffer. Injected by the transport. */
export type MediaDownloader = (msg: WAMessage) => Promise<Buffer>;

/**
 * Unwrap future-proof/wrapper envelopes (ephemeral, view-once, edited,
 * document-with-caption, device-sent) down to the real message content.
 * Returns undefined for empty content.
 */
export function unwrapContent(
  content: proto.IMessage | null | undefined
): proto.IMessage | undefined {
  let current = content ?? undefined;
  // Bounded like baileys' own normalizeMessageContent — wrappers never nest deeper.
  for (let i = 0; i < 6 && current; i++) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message ??
      current.deviceSentMessage?.message;
    if (!inner) break;
    current = inner;
  }
  return current ?? undefined;
}

/** Best-effort text of a message content: body, extended text, or media caption. */
export function extractText(content: proto.IMessage): string | undefined {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    undefined
  );
}

/** Media descriptor extracted from message content (no download — pure data). */
export interface ExtractedMedia {
  kind: MediaKind;
  mimetype?: string;
  filename?: string;
  ptt?: boolean;
  caption?: string;
}

/** Extract media info from message content, or undefined when it holds no media. */
export function extractMediaInfo(content: proto.IMessage): ExtractedMedia | undefined {
  const image = content.imageMessage;
  if (image) {
    return { kind: 'image', mimetype: image.mimetype ?? undefined, caption: image.caption ?? undefined };
  }
  const video = content.videoMessage;
  if (video) {
    return { kind: 'video', mimetype: video.mimetype ?? undefined, caption: video.caption ?? undefined };
  }
  const audio = content.audioMessage;
  if (audio) {
    return { kind: 'audio', mimetype: audio.mimetype ?? undefined, ptt: audio.ptt === true };
  }
  const document = content.documentMessage;
  if (document) {
    return {
      kind: 'document',
      mimetype: document.mimetype ?? undefined,
      filename: document.fileName ?? undefined,
      caption: document.caption ?? undefined,
    };
  }
  const sticker = content.stickerMessage;
  if (sticker) {
    return { kind: 'sticker', mimetype: sticker.mimetype ?? undefined };
  }
  return undefined;
}

/** Find the contextInfo of whichever inner message carries one and build a QuotedRef. */
export function extractQuoted(content: proto.IMessage): QuotedRef | undefined {
  const ctx =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.stickerMessage?.contextInfo ??
    content.locationMessage?.contextInfo;
  const stanzaId = ctx?.stanzaId;
  if (!ctx || !stanzaId) return undefined;
  const quoted: QuotedRef = { id: stanzaId };
  const quotedContent = unwrapContent(ctx.quotedMessage);
  const text = quotedContent ? extractText(quotedContent) : undefined;
  if (text !== undefined) quoted.text = text;
  if (ctx.participant) quoted.senderId = ctx.participant;
  return quoted;
}

/** Seconds-since-epoch (number or protobuf Long) → ms since epoch; now() when absent. */
function toMillis(ts: WAMessage['messageTimestamp']): number {
  if (ts == null) return Date.now();
  const seconds = typeof ts === 'number' ? ts : Number(ts.toString());
  if (!Number.isFinite(seconds) || seconds <= 0) return Date.now();
  return seconds * 1000;
}

/**
 * Map one Baileys `messages.upsert` message to a normalized {@link InboundMessage}.
 *
 * Returns undefined for messages wappa does not deliver: protocol/system/stub
 * messages and content types with nothing mappable (polls, contacts, calls, ...),
 * messages without a key id or chat jid, broadcast/status jids
 * (`status@broadcast` is not a conversation a bot can reply into), and
 * `@newsletter` jids (WhatsApp Channel posts are not DMs a bot should answer).
 *
 * @param msg the raw Baileys message (kept as `raw` on the result)
 * @param downloadMedia lazily invoked by `media.download()`; the transport wires
 *   baileys' `downloadMediaMessage` here, tests inject a stub
 */
export function mapMessage(
  msg: WAMessage,
  downloadMedia: MediaDownloader
): InboundMessage | undefined {
  const key = msg.key;
  const chatId = key?.remoteJid;
  const id = key?.id;
  if (!chatId || !id) return undefined;
  if (chatId.endsWith('@broadcast') || chatId.endsWith('@newsletter')) return undefined;

  const content = unwrapContent(msg.message);
  if (!content) return undefined;

  const inbound: InboundMessage = {
    id,
    chatId,
    senderId: key.participant || chatId,
    timestamp: toMillis(msg.messageTimestamp),
    isGroup: chatId.endsWith('@g.us'),
    fromMe: key.fromMe === true,
    raw: msg,
  };
  if (msg.pushName) inbound.senderName = msg.pushName;

  const reaction = content.reactionMessage;
  if (reaction) {
    inbound.reaction = {
      emoji: reaction.text ?? '',
      targetMessageId: reaction.key?.id ?? '',
    };
    return inbound;
  }

  const quoted = extractQuoted(content);
  if (quoted) inbound.quoted = quoted;

  const location = content.locationMessage;
  if (location && location.degreesLatitude != null && location.degreesLongitude != null) {
    inbound.location = {
      latitude: location.degreesLatitude,
      longitude: location.degreesLongitude,
    };
    if (location.name) inbound.location.name = location.name;
    if (location.address) inbound.location.address = location.address;
    return inbound;
  }

  const media = extractMediaInfo(content);
  if (media) {
    const ref: MediaRef = { kind: media.kind, download: () => downloadMedia(msg) };
    if (media.mimetype !== undefined) ref.mimetype = media.mimetype;
    if (media.filename !== undefined) ref.filename = media.filename;
    if (media.ptt) ref.ptt = true;
    inbound.media = ref;
    if (media.caption !== undefined) inbound.text = media.caption;
    return inbound;
  }

  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (text != null) {
    inbound.text = text;
    return inbound;
  }

  // Nothing mappable (protocolMessage, pollCreationMessage, contactMessage, ...).
  return undefined;
}

/**
 * Render the numbered text fallback for quick-reply buttons (Baileys has no
 * native quick-reply buttons): `text + '\n\n1. Title A\n2. Title B'`.
 * With no text, only the numbered list is returned.
 */
export function renderButtonFallback(
  text: string | undefined,
  buttons: readonly OutboundButton[]
): string {
  const lines = buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  return text ? `${text}\n\n${lines}` : lines;
}

/** Buffer passes through; a string (https:/http:/data: URL or local file path) becomes `{ url }`. */
function toMediaUpload(data: Buffer | string): WAMediaUpload {
  return Buffer.isBuffer(data) ? data : { url: data };
}

/**
 * Map an {@link OutboundPayload} to Baileys send content.
 *
 * Rules: media wins over location, which wins over text. Buttons are rendered
 * as the numbered text fallback appended to the text (or to a captionable
 * media's caption); audio/sticker carry no caption, and location carries no
 * text, so any text/buttons alongside those are dropped. `payload.replyTo` is
 * not handled here — Baileys quoting needs the full original WAMessage, which
 * the transport does not retain, so quoting is skipped (best-effort per spec).
 *
 * @throws Error when the payload has no sendable content
 */
export function toBaileysContent(payload: OutboundPayload): AnyMessageContent {
  const { media, location, buttons } = payload;

  if (media) {
    const upload = toMediaUpload(media.data);
    let caption = media.caption ?? payload.text;
    if (buttons?.length && (media.kind === 'image' || media.kind === 'video' || media.kind === 'document')) {
      caption = renderButtonFallback(caption, buttons);
    }
    switch (media.kind) {
      case 'image':
        return { image: upload, caption, mimetype: media.mimetype };
      case 'video':
        return { video: upload, caption, mimetype: media.mimetype };
      case 'audio':
        return { audio: upload, ptt: media.ptt, mimetype: media.mimetype };
      case 'sticker':
        return { sticker: upload, mimetype: media.mimetype };
      case 'document':
        return {
          document: upload,
          mimetype: media.mimetype ?? 'application/octet-stream',
          fileName: media.filename,
          caption,
        };
    }
  }

  if (location) {
    return {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.name,
        address: location.address,
      },
    };
  }

  if (buttons?.length) {
    return { text: renderButtonFallback(payload.text, buttons) };
  }

  if (payload.text !== undefined) {
    return { text: payload.text };
  }

  throw new Error('BaileysTransport: outbound payload has no sendable content');
}
