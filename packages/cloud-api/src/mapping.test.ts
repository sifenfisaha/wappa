import { describe, expect, it, vi } from 'vitest';
import type { OutboundPayload } from '@wappa/core';
import { buildSendBody, isHttpUrl, mapWebhookPayload, type InboundMappingDeps } from './mapping.js';

const WAMID = 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTdCNEU1RDlEMjA3NUFCMkYzRQA=';

/** Realistic v23.0 webhook envelope around one `value` object. */
function envelope(value: Record<string, unknown>): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'PHONE_ID' },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

/** Envelope with the default contact + a single message. */
function messageEnvelope(msg: Record<string, unknown>): unknown {
  return envelope({
    contacts: [{ profile: { name: 'Kerry Fisher' }, wa_id: '15551234567' }],
    messages: [msg],
  });
}

function makeDeps(): InboundMappingDeps & { downloadMedia: ReturnType<typeof vi.fn> } {
  return { downloadMedia: vi.fn(async (id: string) => Buffer.from(`bytes:${id}`)) };
}

describe('mapWebhookPayload', () => {
  it('maps a text message with all base fields', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000000',
        type: 'text',
        text: { body: 'hello there' },
      }),
      makeDeps(),
    );
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(m.id).toBe(WAMID);
    expect(m.chatId).toBe('15551234567');
    expect(m.senderId).toBe('15551234567');
    expect(m.senderName).toBe('Kerry Fisher');
    expect(m.timestamp).toBe(1756000000 * 1000);
    expect(m.isGroup).toBe(false);
    expect(m.fromMe).toBe(false);
    expect(m.text).toBe('hello there');
    expect(m.media).toBeUndefined();
    expect(m.buttonId).toBeUndefined();
    expect(m.raw).toMatchObject({ type: 'text' });
  });

  it('maps interactive button_reply: text = title, buttonId = id', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000001',
        type: 'interactive',
        interactive: { type: 'button_reply', button_reply: { id: 'btn-track', title: 'Track order' } },
      }),
      makeDeps(),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('Track order');
    expect(msgs[0]!.buttonId).toBe('btn-track');
  });

  it('maps interactive list_reply: text = title, buttonId = id', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000002',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'row-2', title: 'Large', description: 'Feeds four' },
        },
      }),
      makeDeps(),
    );
    expect(msgs[0]!.text).toBe('Large');
    expect(msgs[0]!.buttonId).toBe('row-2');
  });

  it('maps template button replies: text = button.text, buttonId = payload', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000003',
        type: 'button',
        button: { text: 'Yes, confirm', payload: 'CONFIRM_PAYLOAD' },
      }),
      makeDeps(),
    );
    expect(msgs[0]!.text).toBe('Yes, confirm');
    expect(msgs[0]!.buttonId).toBe('CONFIRM_PAYLOAD');
  });

  it('maps an image with caption to a lazy MediaRef', async () => {
    const deps = makeDeps();
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000004',
        type: 'image',
        image: {
          id: 'MEDIA_ID_123',
          mime_type: 'image/jpeg',
          sha256: 'sGmLxCarLLL9SmhBBRWJBjIfsQrDYcTGBFwCjyxJUFI=',
          caption: 'look at this',
        },
      }),
      deps,
    );
    const m = msgs[0]!;
    expect(m.text).toBe('look at this');
    expect(m.media).toBeDefined();
    expect(m.media!.kind).toBe('image');
    expect(m.media!.mimetype).toBe('image/jpeg');
    // Download is lazy: not called until requested.
    expect(deps.downloadMedia).not.toHaveBeenCalled();
    const buf = await m.media!.download();
    expect(deps.downloadMedia).toHaveBeenCalledWith('MEDIA_ID_123');
    expect(buf).toEqual(Buffer.from('bytes:MEDIA_ID_123'));
  });

  it('maps a voice note with ptt: true', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000005',
        type: 'audio',
        audio: { id: 'AUDIO_ID', mime_type: 'audio/ogg; codecs=opus', voice: true },
      }),
      makeDeps(),
    );
    expect(msgs[0]!.media!.kind).toBe('audio');
    expect(msgs[0]!.media!.ptt).toBe(true);
  });

  it('maps a document with filename', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000006',
        type: 'document',
        document: { id: 'DOC_ID', mime_type: 'application/pdf', filename: 'invoice.pdf' },
      }),
      makeDeps(),
    );
    expect(msgs[0]!.media!.kind).toBe('document');
    expect(msgs[0]!.media!.filename).toBe('invoice.pdf');
  });

  it('maps a location message', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000007',
        type: 'location',
        location: { latitude: 37.4847, longitude: -122.1477, name: 'Meta HQ', address: '1 Hacker Way' },
      }),
      makeDeps(),
    );
    expect(msgs[0]!.location).toEqual({
      latitude: 37.4847,
      longitude: -122.1477,
      name: 'Meta HQ',
      address: '1 Hacker Way',
    });
  });

  it('maps a reaction message', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000008',
        type: 'reaction',
        reaction: { emoji: '\u{1F44D}', message_id: 'wamid.TARGET' },
      }),
      makeDeps(),
    );
    expect(msgs[0]!.reaction).toEqual({ emoji: '\u{1F44D}', targetMessageId: 'wamid.TARGET' });
  });

  it('maps context to quoted', () => {
    const msgs = mapWebhookPayload(
      messageEnvelope({
        from: '15551234567',
        id: WAMID,
        timestamp: '1756000009',
        type: 'text',
        text: { body: 'replying' },
        context: { from: '15550001111', id: 'wamid.ORIGINAL' },
      }),
      makeDeps(),
    );
    expect(msgs[0]!.quoted).toEqual({ id: 'wamid.ORIGINAL', senderId: '15550001111' });
  });

  it('ignores statuses events', () => {
    const msgs = mapWebhookPayload(
      envelope({
        statuses: [
          {
            id: WAMID,
            status: 'delivered',
            timestamp: '1756000010',
            recipient_id: '15551234567',
            conversation: { id: 'CONV_ID', origin: { type: 'service' } },
          },
        ],
      }),
      makeDeps(),
    );
    expect(msgs).toEqual([]);
  });

  it('skips unmapped message types silently with a debug log', () => {
    const debug = vi.fn();
    const logger = { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    for (const type of ['contacts', 'order', 'system', 'unsupported', 'unknown']) {
      const msgs = mapWebhookPayload(
        messageEnvelope({ from: '15551234567', id: WAMID, timestamp: '1756000011', type }),
        { ...makeDeps(), logger },
      );
      expect(msgs).toEqual([]);
    }
    expect(debug).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('matches senderName by wa_id in a multi-sender batch', () => {
    const msgs = mapWebhookPayload(
      envelope({
        contacts: [
          { profile: { name: 'Ann' }, wa_id: '1000' },
          { profile: { name: 'Ben' }, wa_id: '2000' },
        ],
        messages: [
          { from: '1000', id: 'wamid.a', timestamp: '1756000000', type: 'text', text: { body: 'one' } },
          { from: '2000', id: 'wamid.b', timestamp: '1756000001', type: 'text', text: { body: 'two' } },
        ],
      }),
      makeDeps(),
    );
    expect(msgs.map((m) => m.senderName)).toEqual(['Ann', 'Ben']);
  });

  it('falls back to contacts[0] for senderName when no wa_id matches from', () => {
    const msgs = mapWebhookPayload(
      envelope({
        // wa_id differs from `from` in some locales (e.g. number normalization).
        contacts: [{ profile: { name: 'Kerry Fisher' }, wa_id: '5215551234567' }],
        messages: [
          { from: '15551234567', id: WAMID, timestamp: '1756000000', type: 'text', text: { body: 'hola' } },
        ],
      }),
      makeDeps(),
    );
    expect(msgs[0]!.senderName).toBe('Kerry Fisher');
  });

  it('maps multiple messages across entries in order', () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001111', phone_number_id: 'PHONE_ID' },
                contacts: [{ profile: { name: 'A' }, wa_id: '1000' }],
                messages: [
                  { from: '1000', id: 'wamid.1', timestamp: '1756000012', type: 'text', text: { body: 'one' } },
                  { from: '1000', id: 'wamid.2', timestamp: '1756000013', type: 'text', text: { body: 'two' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const msgs = mapWebhookPayload(body, makeDeps());
    expect(msgs.map((m) => m.text)).toEqual(['one', 'two']);
  });

  it('returns [] for garbage input', () => {
    for (const bad of [null, undefined, 42, 'nope', {}, { entry: 'x' }, { entry: [{}] }]) {
      expect(mapWebhookPayload(bad, makeDeps())).toEqual([]);
    }
  });
});

describe('buildSendBody', () => {
  it('builds a text body with preview_url', () => {
    expect(buildSendBody('15551234567', { text: 'hi there' })).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'text',
      text: { body: 'hi there', preview_url: true },
    });
  });

  it('builds an interactive body for up to 3 buttons', () => {
    const body = buildSendBody('15551234567', {
      text: 'Pick one',
      buttons: [
        { id: 'a', title: 'Alpha' },
        { id: 'b', title: 'Beta' },
        { id: 'c', title: 'Gamma' },
      ],
    });
    expect(body.type).toBe('interactive');
    expect(body.interactive).toEqual({
      type: 'button',
      body: { text: 'Pick one' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'a', title: 'Alpha' } },
          { type: 'reply', reply: { id: 'b', title: 'Beta' } },
          { type: 'reply', reply: { id: 'c', title: 'Gamma' } },
        ],
      },
    });
  });

  it('throws for more than 3 buttons', () => {
    const payload: OutboundPayload = {
      text: 'too many',
      buttons: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C' },
        { id: 'd', title: 'D' },
      ],
    };
    expect(() => buildSendBody('15551234567', payload)).toThrow(/at most 3/);
  });

  it('throws for buttons without body text', () => {
    expect(() => buildSendBody('1', { buttons: [{ id: 'a', title: 'A' }] })).toThrow(/require/);
  });

  it('attaches URL media as a link-form interactive header alongside buttons', () => {
    const body = buildSendBody('15551234567', {
      text: 'Pick one',
      buttons: [{ id: 'a', title: 'Alpha' }],
      media: { kind: 'image', data: 'https://example.com/cat.jpg' },
    });
    expect(body.type).toBe('interactive');
    const interactive = body.interactive as Record<string, unknown>;
    expect(interactive.header).toEqual({ type: 'image', image: { link: 'https://example.com/cat.jpg' } });
    expect(interactive.body).toEqual({ text: 'Pick one' });
  });

  it('attaches uploaded media as an id-form interactive header alongside buttons', () => {
    const body = buildSendBody(
      '15551234567',
      {
        text: 'The invoice',
        buttons: [{ id: 'a', title: 'Open' }],
        media: { kind: 'document', data: Buffer.from('pdf'), mimetype: 'application/pdf' },
      },
      'UPLOADED_9',
    );
    const interactive = body.interactive as Record<string, unknown>;
    expect(interactive.header).toEqual({ type: 'document', document: { id: 'UPLOADED_9' } });
  });

  it('throws for Buffer media alongside buttons without an uploaded id', () => {
    expect(() =>
      buildSendBody('1', {
        text: 'Pick',
        buttons: [{ id: 'a', title: 'A' }],
        media: { kind: 'image', data: Buffer.from('x') },
      }),
    ).toThrow(/upload/);
  });

  it('drops audio/sticker media with a warning when buttons are present (no header)', () => {
    for (const kind of ['audio', 'sticker'] as const) {
      const warn = vi.fn();
      const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
      const body = buildSendBody(
        '15551234567',
        {
          text: 'Pick one',
          buttons: [{ id: 'a', title: 'Alpha' }],
          media: { kind, data: 'https://example.com/media.bin' },
        },
        undefined,
        logger,
      );
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(kind)), expect.anything());
      const interactive = body.interactive as Record<string, unknown>;
      expect(interactive.header).toBeUndefined();
      expect(body.type).toBe('interactive');
    }
  });

  it('builds link-form media for https URLs, with caption', () => {
    const body = buildSendBody('15551234567', {
      media: { kind: 'image', data: 'https://example.com/cat.jpg', caption: 'a cat' },
    });
    expect(body.type).toBe('image');
    expect(body.image).toEqual({ link: 'https://example.com/cat.jpg', caption: 'a cat' });
  });

  it('falls back to payload.text as caption and includes document filename', () => {
    const body = buildSendBody(
      '15551234567',
      {
        text: 'the invoice',
        media: { kind: 'document', data: Buffer.from('pdf'), filename: 'invoice.pdf', mimetype: 'application/pdf' },
      },
      'UPLOADED_1',
    );
    expect(body.type).toBe('document');
    expect(body.document).toEqual({ id: 'UPLOADED_1', caption: 'the invoice', filename: 'invoice.pdf' });
  });

  it('omits captions for audio and sticker', () => {
    const audio = buildSendBody(
      '1',
      { media: { kind: 'audio', data: Buffer.from('x'), caption: 'nope', mimetype: 'audio/ogg' } },
      'M1',
    );
    expect(audio.audio).toEqual({ id: 'M1' });
    const sticker = buildSendBody(
      '1',
      { media: { kind: 'sticker', data: Buffer.from('x'), caption: 'nope', mimetype: 'image/webp' } },
      'M2',
    );
    expect(sticker.sticker).toEqual({ id: 'M2' });
  });

  it('throws for Buffer/path media without an uploaded id', () => {
    expect(() => buildSendBody('1', { media: { kind: 'image', data: Buffer.from('x') } })).toThrow(/upload/);
    expect(() => buildSendBody('1', { media: { kind: 'image', data: './local/cat.jpg' } })).toThrow(/upload/);
  });

  it('builds a location body', () => {
    const body = buildSendBody('15551234567', {
      location: { latitude: 9.005, longitude: 38.763, name: 'Addis Ababa', address: 'Ethiopia' },
    });
    expect(body.type).toBe('location');
    expect(body.location).toEqual({ latitude: 9.005, longitude: 38.763, name: 'Addis Ababa', address: 'Ethiopia' });
  });

  it('adds context.message_id for replyTo', () => {
    const body = buildSendBody('15551234567', { text: 'reply', replyTo: 'wamid.ORIGINAL' });
    expect(body.context).toEqual({ message_id: 'wamid.ORIGINAL' });
  });

  it('throws for an empty payload', () => {
    expect(() => buildSendBody('15551234567', {})).toThrow(/nothing to send/i);
  });
});

describe('isHttpUrl', () => {
  it('accepts http(s) URLs and rejects paths/buffers-as-strings', () => {
    expect(isHttpUrl('https://example.com/a.jpg')).toBe(true);
    expect(isHttpUrl('http://example.com/a.jpg')).toBe(true);
    expect(isHttpUrl('HTTPS://EXAMPLE.COM/A.JPG')).toBe(true);
    expect(isHttpUrl('./local/file.jpg')).toBe(false);
    expect(isHttpUrl('/abs/path.jpg')).toBe(false);
    expect(isHttpUrl('file:///x.jpg')).toBe(false);
  });
});
