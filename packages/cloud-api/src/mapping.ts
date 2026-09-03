/**
 * Pure mapping between WhatsApp Cloud API (Graph API v23.0) shapes and the wappa
 * normalized message model. No I/O happens here — media downloads are injected
 * via {@link InboundMappingDeps.downloadMedia} so the functions stay unit-testable.
 */
import type {
  InboundMessage,
  Location,
  Logger,
  MediaKind,
  MediaRef,
  OutboundPayload,
  QuotedRef,
} from '@wappa/core';

/** Subset of a Cloud API media object (image/audio/video/document/sticker). */
export interface CloudApiMediaObject {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  /** true when an audio message is a voice note. */
  voice?: boolean;
  animated?: boolean;
}

/** Subset of one element of `entry[].changes[].value.contacts[]`. */
export interface CloudApiContact {
  wa_id?: string;
  profile?: { name?: string };
}

/** Subset of one element of `entry[].changes[].value.messages[]`. */
export interface CloudApiMessage {
  from?: string;
  id?: string;
  /** Unix seconds, as a string. */
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  /** Template quick-reply button press. */
  button?: { text?: string; payload?: string };
  image?: CloudApiMediaObject;
  audio?: CloudApiMediaObject;
  video?: CloudApiMediaObject;
  document?: CloudApiMediaObject;
  sticker?: CloudApiMediaObject;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?: { emoji?: string; message_id?: string };
  context?: { id?: string; from?: string };
  [key: string]: unknown;
}

/** Dependencies injected into {@link mapWebhookPayload}. */
export interface InboundMappingDeps {
  /** Downloads the bytes of a Cloud API media id (two-hop Graph API fetch). */
  downloadMedia: (mediaId: string) => Promise<Buffer>;
  logger?: Logger;
}

const MEDIA_TYPES: readonly MediaKind[] = ['image', 'audio', 'video', 'document', 'sticker'];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Map a full Cloud API webhook POST body to normalized inbound messages.
 *
 * Walks `entry[].changes[].value.messages[]`. `statuses` events are ignored, and
 * messages of unmapped types (contacts, order, system, unsupported, unknown) are
 * skipped silently (debug-log only). Cloud API is DM-only, so `isGroup` is always
 * false and `chatId === senderId === messages[].from`.
 */
export function mapWebhookPayload(body: unknown, deps: InboundMappingDeps): InboundMessage[] {
  const out: InboundMessage[] = [];
  const root = asRecord(body);
  if (!root || !Array.isArray(root.entry)) return out;
  for (const entry of root.entry) {
    const changes = asRecord(entry)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = asRecord(asRecord(change)?.value);
      if (!value) continue;
      // Delivery/read receipts arrive under `statuses` — deliberately ignored.
      if (!Array.isArray(value.messages)) continue;
      const contacts = Array.isArray(value.contacts) ? (value.contacts as CloudApiContact[]) : [];
      for (const raw of value.messages) {
        const msg = asRecord(raw) as CloudApiMessage | undefined;
        if (!msg) continue;
        const mapped = mapCloudApiMessage(msg, contacts, deps);
        if (mapped) out.push(mapped);
      }
    }
  }
  return out;
}

/**
 * Map one `value.messages[]` element to an {@link InboundMessage}, or `undefined`
 * for unmapped/unsupported message types (skipped silently, debug-log only).
 */
export function mapCloudApiMessage(
  msg: CloudApiMessage,
  contacts: CloudApiContact[],
  deps: InboundMappingDeps,
): InboundMessage | undefined {
  const from = typeof msg.from === 'string' ? msg.from : undefined;
  const id = typeof msg.id === 'string' ? msg.id : undefined;
  if (!from || !id) {
    deps.logger?.debug('cloud-api: skipping message without from/id', { type: msg.type });
    return undefined;
  }

  const seconds = Number(msg.timestamp);
  // Meta batches multiple senders per value with a parallel contacts[] array —
  // match on wa_id, falling back to contacts[0] (wa_id can differ from `from`
  // in some locales).
  const base: InboundMessage = {
    id,
    chatId: from,
    senderId: from,
    senderName: contacts.find((c) => c.wa_id === from)?.profile?.name ?? contacts[0]?.profile?.name,
    timestamp: Number.isFinite(seconds) ? seconds * 1000 : Date.now(),
    isGroup: false,
    fromMe: false,
    raw: msg,
  };
  const quoted = mapContext(msg);
  if (quoted) base.quoted = quoted;

  const type = msg.type ?? '';
  switch (type) {
    case 'text': {
      if (typeof msg.text?.body !== 'string') break;
      return { ...base, text: msg.text.body };
    }
    case 'interactive': {
      const ir = msg.interactive;
      const reply =
        ir?.type === 'button_reply' ? ir.button_reply : ir?.type === 'list_reply' ? ir.list_reply : undefined;
      if (typeof reply?.id !== 'string' || typeof reply.title !== 'string') break;
      return { ...base, text: reply.title, buttonId: reply.id };
    }
    case 'button': {
      // Template quick-reply press: `text` is the button title, `payload` its id.
      const b = msg.button;
      if (typeof b?.text !== 'string') break;
      const mapped: InboundMessage = { ...base, text: b.text };
      if (typeof b.payload === 'string') mapped.buttonId = b.payload;
      return mapped;
    }
    case 'location': {
      const loc = msg.location;
      if (typeof loc?.latitude !== 'number' || typeof loc.longitude !== 'number') break;
      const location: Location = { latitude: loc.latitude, longitude: loc.longitude };
      if (typeof loc.name === 'string') location.name = loc.name;
      if (typeof loc.address === 'string') location.address = loc.address;
      return { ...base, location };
    }
    case 'reaction': {
      const r = msg.reaction;
      if (typeof r?.emoji !== 'string' || typeof r.message_id !== 'string') break;
      return { ...base, reaction: { emoji: r.emoji, targetMessageId: r.message_id } };
    }
    default: {
      if ((MEDIA_TYPES as readonly string[]).includes(type)) {
        const media = mapMedia(type as MediaKind, msg, deps);
        if (!media) break;
        const mapped: InboundMessage = { ...base, media };
        const caption = (msg[type] as CloudApiMediaObject | undefined)?.caption;
        if (typeof caption === 'string') mapped.text = caption;
        return mapped;
      }
      break;
    }
  }

  deps.logger?.debug('cloud-api: skipping unmapped message type', { type, id });
  return undefined;
}

function mapMedia(kind: MediaKind, msg: CloudApiMessage, deps: InboundMappingDeps): MediaRef | undefined {
  const obj = msg[kind] as CloudApiMediaObject | undefined;
  const mediaId = obj?.id;
  if (typeof mediaId !== 'string') return undefined;
  const ref: MediaRef = {
    kind,
    download: () => deps.downloadMedia(mediaId),
  };
  if (typeof obj?.mime_type === 'string') ref.mimetype = obj.mime_type;
  if (typeof obj?.filename === 'string') ref.filename = obj.filename;
  if (obj?.voice === true) ref.ptt = true;
  return ref;
}

function mapContext(msg: CloudApiMessage): QuotedRef | undefined {
  const ctx = msg.context;
  if (typeof ctx?.id !== 'string') return undefined;
  const quoted: QuotedRef = { id: ctx.id };
  if (typeof ctx.from === 'string') quoted.senderId = ctx.from;
  return quoted;
}

/** True for absolute http(s) URLs — media strings of any other shape are treated as local file paths. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * Build the Graph API `POST /{phoneNumberId}/messages` request body for one
 * {@link OutboundPayload}.
 *
 * Precedence when multiple fields are present: `buttons` (interactive) > `media` >
 * `location` > `text`. Buttons require `text` (the interactive body) and at most 3
 * entries — more throws. Media alongside buttons becomes the interactive message
 * header (link-form for URL media, id-form for uploaded media); audio/sticker
 * cannot be a header and are dropped with a warning on `logger`. Media given as a
 * Buffer or local file path must already be uploaded; pass the resulting media id
 * as `uploadedMediaId` ({@link CloudApiTransport} does this automatically).
 * `replyTo` becomes `context.message_id`.
 */
export function buildSendBody(
  to: string,
  payload: OutboundPayload,
  uploadedMediaId?: string,
  logger?: Logger,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
  };
  if (payload.replyTo) body.context = { message_id: payload.replyTo };

  const { buttons, media, location, text } = payload;

  if (buttons && buttons.length > 0) {
    if (buttons.length > 3) {
      throw new Error(`Cloud API supports at most 3 quick-reply buttons, got ${buttons.length}`);
    }
    if (!text) {
      throw new Error('Cloud API interactive button messages require `text` (the message body)');
    }
    const interactive: Record<string, unknown> = {
      type: 'button',
      body: { text },
      action: {
        buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    };
    if (media) {
      if (media.kind === 'audio' || media.kind === 'sticker') {
        logger?.warn(
          `cloud-api: ${media.kind} media cannot be an interactive button header — media dropped`,
          { kind: media.kind },
        );
      } else {
        const header: Record<string, unknown> = {};
        if (typeof media.data === 'string' && isHttpUrl(media.data)) {
          header.link = media.data;
        } else if (uploadedMediaId) {
          header.id = uploadedMediaId;
        } else {
          throw new Error(
            'Media given as a Buffer or local file path must be uploaded first — pass uploadedMediaId (CloudApiTransport.send does this automatically)',
          );
        }
        interactive.header = { type: media.kind, [media.kind]: header };
      }
    }
    body.type = 'interactive';
    body.interactive = interactive;
    return body;
  }

  if (media) {
    const obj: Record<string, unknown> = {};
    if (typeof media.data === 'string' && isHttpUrl(media.data)) {
      obj.link = media.data;
    } else if (uploadedMediaId) {
      obj.id = uploadedMediaId;
    } else {
      throw new Error(
        'Media given as a Buffer or local file path must be uploaded first — pass uploadedMediaId (CloudApiTransport.send does this automatically)',
      );
    }
    // Cloud API rejects captions on audio and sticker messages.
    const caption = media.caption ?? text;
    if (caption && media.kind !== 'audio' && media.kind !== 'sticker') obj.caption = caption;
    if (media.kind === 'document' && media.filename) obj.filename = media.filename;
    body.type = media.kind;
    body[media.kind] = obj;
    return body;
  }

  if (location) {
    const loc: Record<string, unknown> = { latitude: location.latitude, longitude: location.longitude };
    if (location.name) loc.name = location.name;
    if (location.address) loc.address = location.address;
    body.type = 'location';
    body.location = loc;
    return body;
  }

  if (text !== undefined) {
    body.type = 'text';
    body.text = { body: text, preview_url: true };
    return body;
  }

  throw new Error('Empty OutboundPayload: nothing to send');
}
