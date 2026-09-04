/**
 * Pure mapping between Twilio webhook/Messages-API shapes and the wappa
 * normalized message model. No I/O happens here — media downloads are injected
 * via {@link InboundMappingDeps.downloadMedia} so the functions stay
 * unit-testable.
 */
import type {
  InboundMessage,
  Location,
  Logger,
  MediaKind,
  MediaRef,
  OutboundButton,
  OutboundPayload,
} from '@wappa/core';

/** Decoded Twilio webhook POST parameters — the full param bag. */
export type TwilioParams = Record<string, string>;

/** Dependencies injected into {@link mapTwilioParams}. */
export interface InboundMappingDeps {
  /** Downloads the bytes behind a Twilio media URL (basic-auth GET, redirects followed). */
  downloadMedia: (url: string) => Promise<Buffer>;
  logger?: Logger;
}

/**
 * True for delivery-status callbacks: a `MessageStatus`/`SmsStatus` param with
 * no inbound content. Twilio marks genuine inbound messages `SmsStatus:
 * received` too, so "no inbound content" checks every content-bearing param —
 * no Body, NumMedia 0, no ButtonText, no Latitude/Longitude, not a reaction.
 * Status callbacks are acknowledged and otherwise ignored.
 */
export function isStatusCallback(params: TwilioParams): boolean {
  if (params.MessageStatus === undefined && params.SmsStatus === undefined) return false;
  const hasContent =
    Boolean(params.Body) ||
    Boolean(params.ButtonText) ||
    Number(params.NumMedia ?? '0') > 0 ||
    (params.Latitude !== undefined && params.Longitude !== undefined) ||
    params.MessageType === 'reaction';
  return !hasContent;
}

/** Derive a {@link MediaKind} from `MediaContentType0` (WhatsApp stickers arrive as image/webp). */
export function mediaKindFromContentType(contentType: string | undefined): MediaKind {
  if (!contentType) return 'document';
  if (contentType === 'image/webp') return 'sticker';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * Map one decoded Twilio webhook param bag to an {@link InboundMessage}, or
 * `undefined` for unmapped/contentless payloads (skipped silently, debug-log
 * only — run {@link isStatusCallback} first to keep status callbacks out).
 *
 * Twilio WhatsApp is DM-only, so `isGroup` is always false and
 * `chatId === senderId === From` VERBATIM (e.g. `whatsapp:+15551234567`) — ids
 * are transport-specific and round-trip into `send()`. Twilio sends no epoch,
 * so `timestamp` is the arrival time.
 */
export function mapTwilioParams(params: TwilioParams, deps: InboundMappingDeps): InboundMessage | undefined {
  const id = params.MessageSid;
  const from = params.From;
  if (!id || !from) {
    deps.logger?.debug('twilio: skipping webhook params without MessageSid/From');
    return undefined;
  }

  const base: InboundMessage = {
    id,
    chatId: from,
    senderId: from,
    timestamp: Date.now(),
    isGroup: false,
    fromMe: false,
    raw: params,
  };
  if (params.ProfileName) base.senderName = params.ProfileName;

  // Reactions: the emoji arrives in Body, the target under OriginalRepliedMessageSid.
  if (params.MessageType === 'reaction') {
    const target = params.OriginalRepliedMessageSid;
    if (!params.Body || !target) {
      deps.logger?.debug('twilio: skipping reaction without Body/OriginalRepliedMessageSid', { id });
      return undefined;
    }
    return { ...base, reaction: { emoji: params.Body, targetMessageId: target } };
  }

  if (params.OriginalRepliedMessageSid) base.quoted = { id: params.OriginalRepliedMessageSid };

  let hasContent = false;
  // Template quick replies carry the pressed title in ButtonText (Body usually
  // duplicates it) and the postback id in ButtonPayload.
  const text = params.Body || params.ButtonText;
  if (text) {
    base.text = text;
    hasContent = true;
  }
  if (params.ButtonPayload) base.buttonId = params.ButtonPayload;

  const media = mapMedia(params, deps);
  if (media) {
    base.media = media;
    hasContent = true;
  }

  const location = mapLocation(params);
  if (location) {
    base.location = location;
    hasContent = true;
  }

  if (!hasContent) {
    deps.logger?.debug('twilio: skipping contentless webhook params', {
      id,
      messageType: params.MessageType,
    });
    return undefined;
  }
  return base;
}

function mapMedia(params: TwilioParams, deps: InboundMappingDeps): MediaRef | undefined {
  const url = params.MediaUrl0;
  if (!(Number(params.NumMedia ?? '0') > 0) || !url) return undefined;
  const contentType = params.MediaContentType0;
  const ref: MediaRef = {
    kind: mediaKindFromContentType(contentType),
    download: () => deps.downloadMedia(url),
  };
  if (contentType) ref.mimetype = contentType;
  // WhatsApp voice notes arrive as audio/ogg (opus).
  if (contentType?.startsWith('audio/ogg')) ref.ptt = true;
  return ref;
}

function mapLocation(params: TwilioParams): Location | undefined {
  if (params.Latitude === undefined || params.Longitude === undefined) return undefined;
  const latitude = Number(params.Latitude);
  const longitude = Number(params.Longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
  const location: Location = { latitude, longitude };
  if (params.Label) location.name = params.Label;
  if (params.Address) location.address = params.Address;
  return location;
}

/** Prepend `whatsapp:` when missing — chat ids and sender numbers are accepted in either form. */
export function ensureWhatsappPrefix(id: string): string {
  return id.startsWith('whatsapp:') ? id : `whatsapp:${id}`;
}

/** True for absolute http(s) URLs — media strings of any other shape are treated as local file paths. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Render the numbered text fallback for quick-reply buttons (native Twilio
 * buttons need pre-registered Content Templates — out of scope):
 * `text + '\n\n1. Title A\n2. Title B'`. With no text, only the numbered list
 * is returned.
 */
export function renderButtonFallback(text: string | undefined, buttons: readonly OutboundButton[]): string {
  const lines = buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n');
  return text ? `${text}\n\n${lines}` : lines;
}

/**
 * Build the Twilio Messages API form body for one {@link OutboundPayload}.
 *
 * `To`/`From` get the `whatsapp:` prefix prepended when missing (an already
 * prefixed inbound `chatId` round-trips verbatim). `text` becomes `Body`;
 * buttons render as the numbered text fallback appended to it. Media must be a
 * public http(s) URL → `MediaUrl` (its caption wins over `text` as `Body`);
 * Twilio has NO binary upload for messaging, so a Buffer or local file path
 * throws. A location becomes `PersistentAction=geo:{lat},{lon}|{name}`.
 * `replyTo` is skipped with a debug log (no API support).
 *
 * @throws Error when media is not a URL or the payload has no sendable content
 */
export function buildSendParams(
  to: string,
  from: string,
  payload: OutboundPayload,
  logger?: Logger,
): URLSearchParams {
  if (payload.replyTo) {
    logger?.debug('twilio: replyTo is not supported by the Messages API — skipped', {
      replyTo: payload.replyTo,
    });
  }

  const { media, location, buttons, text } = payload;
  let mediaUrl: string | undefined;
  let body = text;
  if (media) {
    if (Buffer.isBuffer(media.data) || !isHttpUrl(media.data)) {
      throw new Error(
        'Twilio cannot send media from a Buffer or local file path — the Messages API has no binary upload; host the file yourself and pass a public http(s) URL as OutboundMedia.data',
      );
    }
    mediaUrl = media.data;
    body = media.caption ?? body;
  }
  if (buttons && buttons.length > 0) body = renderButtonFallback(body, buttons);

  if (body === undefined && mediaUrl === undefined && location === undefined) {
    throw new Error('Empty OutboundPayload: nothing to send');
  }
  // The Messages API rejects requests without Body/MediaUrl/ContentSid (21602), and
  // PersistentAction alone does not satisfy it — synthesize a Body for location-only sends.
  if (body === undefined && mediaUrl === undefined && location) {
    body = location.name ?? location.address ?? `${location.latitude},${location.longitude}`;
  }

  const params = new URLSearchParams();
  params.set('From', ensureWhatsappPrefix(from));
  params.set('To', ensureWhatsappPrefix(to));
  if (body !== undefined) params.set('Body', body);
  if (mediaUrl !== undefined) params.set('MediaUrl', mediaUrl);
  if (location) {
    const geo = `geo:${location.latitude},${location.longitude}${location.name ? `|${location.name}` : ''}`;
    params.append('PersistentAction', geo);
  }
  return params;
}
