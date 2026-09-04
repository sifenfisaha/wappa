import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@wappa/core';
import {
  buildSendParams,
  ensureWhatsappPrefix,
  isHttpUrl,
  isStatusCallback,
  mapTwilioParams,
  mediaKindFromContentType,
  renderButtonFallback,
  type InboundMappingDeps,
  type TwilioParams,
} from './mapping.js';

const SID = 'SM2f2a3c1e9b8d4a6f8c1e2d3b4a5f6e7d';
const FROM = 'whatsapp:+15551234567';

/** Realistic inbound WhatsApp param bag as Twilio decodes it. */
function inbound(overrides: TwilioParams = {}): TwilioParams {
  return {
    SmsMessageSid: SID,
    NumMedia: '0',
    ProfileName: 'Kerry Fisher',
    MessageType: 'text',
    SmsSid: SID,
    WaId: '15551234567',
    SmsStatus: 'received',
    Body: 'hello there',
    To: 'whatsapp:+14155238886',
    NumSegments: '1',
    ReferralNumMedia: '0',
    MessageSid: SID,
    AccountSid: 'AC00000000000000000000000000000000',
    From: FROM,
    ApiVersion: '2010-04-01',
    ...overrides,
  };
}

function makeDeps(): InboundMappingDeps & { downloadMedia: ReturnType<typeof vi.fn>; logger: Logger } {
  return {
    downloadMedia: vi.fn(async (url: string) => Buffer.from(`bytes:${url}`)),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('mapTwilioParams', () => {
  it('maps a text message with all base fields (chatId = From VERBATIM)', () => {
    const params = inbound();
    const before = Date.now();
    const m = mapTwilioParams(params, makeDeps())!;
    expect(m).toBeDefined();
    expect(m.id).toBe(SID);
    expect(m.chatId).toBe('whatsapp:+15551234567');
    expect(m.senderId).toBe('whatsapp:+15551234567');
    expect(m.senderName).toBe('Kerry Fisher');
    expect(m.timestamp).toBeGreaterThanOrEqual(before);
    expect(m.timestamp).toBeLessThanOrEqual(Date.now());
    expect(m.isGroup).toBe(false);
    expect(m.fromMe).toBe(false);
    expect(m.text).toBe('hello there');
    expect(m.media).toBeUndefined();
    expect(m.buttonId).toBeUndefined();
    expect(m.raw).toBe(params); // full param bag
  });

  it('maps template quick replies: text from Body/ButtonText, buttonId = ButtonPayload', () => {
    const m = mapTwilioParams(
      inbound({ MessageType: 'button', Body: 'Track order', ButtonText: 'Track order', ButtonPayload: 'btn-track' }),
      makeDeps(),
    )!;
    expect(m.text).toBe('Track order');
    expect(m.buttonId).toBe('btn-track');
    // ButtonText fills in when Body is empty.
    const noBody = mapTwilioParams(
      inbound({ MessageType: 'button', Body: '', ButtonText: 'Track order', ButtonPayload: 'btn-track' }),
      makeDeps(),
    )!;
    expect(noBody.text).toBe('Track order');
  });

  it('maps media to a lazy MediaRef downloading via the injected fetcher', async () => {
    const deps = makeDeps();
    const m = mapTwilioParams(
      inbound({
        MessageType: 'image',
        Body: 'look',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/SM0/Media/ME0',
        MediaContentType0: 'image/jpeg',
      }),
      deps,
    )!;
    expect(m.media?.kind).toBe('image');
    expect(m.media?.mimetype).toBe('image/jpeg');
    expect(m.media?.ptt).toBeUndefined();
    expect(m.text).toBe('look'); // caption
    expect(deps.downloadMedia).not.toHaveBeenCalled(); // lazy
    const buf = await m.media!.download();
    expect(deps.downloadMedia).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/SM0/Media/ME0',
    );
    expect(buf.toString()).toContain('bytes:');
  });

  it('marks audio/ogg media as a voice note (ptt) and derives kinds from the content type', () => {
    const m = mapTwilioParams(
      inbound({ MessageType: 'audio', Body: '', NumMedia: '1', MediaUrl0: 'https://x/me', MediaContentType0: 'audio/ogg' }),
      makeDeps(),
    )!;
    expect(m.media?.kind).toBe('audio');
    expect(m.media?.ptt).toBe(true);
    expect(mediaKindFromContentType('image/png')).toBe('image');
    expect(mediaKindFromContentType('image/webp')).toBe('sticker'); // WhatsApp stickers
    expect(mediaKindFromContentType('video/mp4')).toBe('video');
    expect(mediaKindFromContentType('audio/mpeg')).toBe('audio');
    expect(mediaKindFromContentType('application/pdf')).toBe('document');
    expect(mediaKindFromContentType(undefined)).toBe('document');
  });

  it('maps Latitude/Longitude (+ Label/Address) to a location', () => {
    const m = mapTwilioParams(
      inbound({
        MessageType: 'location',
        Body: '',
        Latitude: '37.4847',
        Longitude: '-122.1477',
        Label: 'Meta HQ',
        Address: '1 Hacker Way',
      }),
      makeDeps(),
    )!;
    expect(m).toBeDefined(); // not mistaken for a status callback despite SmsStatus + empty Body
    expect(m.location).toEqual({ latitude: 37.4847, longitude: -122.1477, name: 'Meta HQ', address: '1 Hacker Way' });
    expect(m.text).toBeUndefined();
  });

  it('maps reactions: emoji = Body, target = OriginalRepliedMessageSid, no text', () => {
    const m = mapTwilioParams(
      inbound({ MessageType: 'reaction', Body: '\u{1F44D}', OriginalRepliedMessageSid: 'SMtarget' }),
      makeDeps(),
    )!;
    expect(m.reaction).toEqual({ emoji: '\u{1F44D}', targetMessageId: 'SMtarget' });
    expect(m.text).toBeUndefined();
    expect(m.quoted).toBeUndefined();
  });

  it('maps OriginalRepliedMessageSid on a non-reaction to quoted', () => {
    const m = mapTwilioParams(inbound({ OriginalRepliedMessageSid: 'SMquoted' }), makeDeps())!;
    expect(m.quoted).toEqual({ id: 'SMquoted' });
    expect(m.text).toBe('hello there');
  });

  it('skips payloads without MessageSid/From and contentless payloads silently (debug log)', () => {
    const deps = makeDeps();
    expect(mapTwilioParams(inbound({ MessageSid: '' }), deps)).toBeUndefined();
    expect(mapTwilioParams(inbound({ From: '' }), deps)).toBeUndefined();
    expect(mapTwilioParams(inbound({ Body: '', MessageType: 'sticker' }), deps)).toBeUndefined();
    expect(mapTwilioParams(inbound({ MessageType: 'reaction', Body: '' }), deps)).toBeUndefined();
    expect(deps.logger.debug).toHaveBeenCalled();
    expect(deps.logger.error).not.toHaveBeenCalled();
  });
});

describe('isStatusCallback', () => {
  it('is true for MessageStatus/SmsStatus callbacks without inbound content', () => {
    expect(
      isStatusCallback({ MessageSid: SID, MessageStatus: 'delivered', To: FROM, From: 'whatsapp:+14155238886' }),
    ).toBe(true);
    expect(isStatusCallback({ MessageSid: SID, SmsStatus: 'sent', NumMedia: '0', Body: '' })).toBe(true);
  });

  it('is false for genuine inbound messages (Twilio marks them SmsStatus=received)', () => {
    expect(isStatusCallback(inbound())).toBe(false); // text
    expect(isStatusCallback(inbound({ Body: '', NumMedia: '1', MediaUrl0: 'https://x' }))).toBe(false);
    expect(isStatusCallback(inbound({ Body: '', Latitude: '1.5', Longitude: '2.5' }))).toBe(false);
    expect(isStatusCallback(inbound({ Body: '\u{1F44D}', MessageType: 'reaction' }))).toBe(false);
    expect(isStatusCallback(inbound({ Body: '', ButtonText: 'Yes' }))).toBe(false);
  });

  it('is false without any status param at all', () => {
    expect(isStatusCallback({ MessageSid: SID, From: FROM })).toBe(false);
  });
});

describe('helpers', () => {
  it('ensureWhatsappPrefix prepends only when missing', () => {
    expect(ensureWhatsappPrefix('+15551234567')).toBe('whatsapp:+15551234567');
    expect(ensureWhatsappPrefix('whatsapp:+15551234567')).toBe('whatsapp:+15551234567');
  });

  it('isHttpUrl accepts http(s) only', () => {
    expect(isHttpUrl('https://example.com/x.jpg')).toBe(true);
    expect(isHttpUrl('http://example.com/x.jpg')).toBe(true);
    expect(isHttpUrl('/tmp/x.jpg')).toBe(false);
    expect(isHttpUrl('file:///x.jpg')).toBe(false);
  });

  it('renderButtonFallback numbers titles and works without text', () => {
    const buttons = [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ];
    expect(renderButtonFallback('Pick one', buttons)).toBe('Pick one\n\n1. Alpha\n2. Beta');
    expect(renderButtonFallback(undefined, buttons)).toBe('1. Alpha\n2. Beta');
  });
});

describe('buildSendParams', () => {
  const FROM_NUMBER = 'whatsapp:+14155238886';

  it('builds a text body with whatsapp: prepended to a bare To', () => {
    const p = buildSendParams('+15551234567', FROM_NUMBER, { text: 'hi there' });
    expect(Object.fromEntries(p)).toEqual({
      From: 'whatsapp:+14155238886',
      To: 'whatsapp:+15551234567',
      Body: 'hi there',
    });
  });

  it('keeps an already-prefixed chatId verbatim (inbound ids round-trip)', () => {
    const p = buildSendParams(FROM, FROM_NUMBER, { text: 'hi' });
    expect(p.get('To')).toBe(FROM);
  });

  it('sends URL media as MediaUrl with the caption winning as Body', () => {
    const p = buildSendParams(FROM, FROM_NUMBER, {
      text: 'ignored',
      media: { kind: 'image', data: 'https://example.com/cat.jpg', caption: 'a cat' },
    });
    expect(p.get('MediaUrl')).toBe('https://example.com/cat.jpg');
    expect(p.get('Body')).toBe('a cat');
  });

  it('throws a clear error for Buffer and local-path media (public URL required)', () => {
    expect(() =>
      buildSendParams(FROM, FROM_NUMBER, { media: { kind: 'image', data: Buffer.from('png') } }),
    ).toThrow(/public http\(s\) URL/);
    expect(() =>
      buildSendParams(FROM, FROM_NUMBER, { media: { kind: 'image', data: '/tmp/cat.jpg' } }),
    ).toThrow(/no binary upload/);
  });

  it('renders a location as PersistentAction geo:{lat},{lon}|{name}', () => {
    const p = buildSendParams(FROM, FROM_NUMBER, {
      location: { latitude: 37.4847, longitude: -122.1477, name: 'Meta HQ' },
    });
    expect(p.getAll('PersistentAction')).toEqual(['geo:37.4847,-122.1477|Meta HQ']);
    const unnamed = buildSendParams(FROM, FROM_NUMBER, { location: { latitude: 1.5, longitude: -2.5 } });
    expect(unnamed.get('PersistentAction')).toBe('geo:1.5,-2.5');
  });

  it('synthesizes a Body for location-only sends (the API rejects PersistentAction alone, error 21602)', () => {
    const named = buildSendParams(FROM, FROM_NUMBER, {
      location: { latitude: 37.4847, longitude: -122.1477, name: 'Meta HQ' },
    });
    expect(named.get('Body')).toBe('Meta HQ');
    const addressed = buildSendParams(FROM, FROM_NUMBER, {
      location: { latitude: 1, longitude: 2, address: '1 Hacker Way' },
    });
    expect(addressed.get('Body')).toBe('1 Hacker Way');
    const bare = buildSendParams(FROM, FROM_NUMBER, { location: { latitude: 1.5, longitude: -2.5 } });
    expect(bare.get('Body')).toBe('1.5,-2.5');
    const withText = buildSendParams(FROM, FROM_NUMBER, {
      text: 'meet here',
      location: { latitude: 1, longitude: 2 },
    });
    expect(withText.get('Body')).toBe('meet here');
  });

  it('appends the numbered button fallback to Body (and stands alone without text)', () => {
    const buttons = [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ];
    expect(buildSendParams(FROM, FROM_NUMBER, { text: 'Pick one', buttons }).get('Body')).toBe(
      'Pick one\n\n1. Alpha\n2. Beta',
    );
    expect(buildSendParams(FROM, FROM_NUMBER, { buttons }).get('Body')).toBe('1. Alpha\n2. Beta');
  });

  it('skips replyTo with a debug log (no API support)', () => {
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const p = buildSendParams(FROM, FROM_NUMBER, { text: 'reply', replyTo: 'SMoriginal' }, logger);
    expect([...p.keys()]).toEqual(['From', 'To', 'Body']);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/replyTo/), expect.anything());
  });

  it('throws on an empty payload', () => {
    expect(() => buildSendParams(FROM, FROM_NUMBER, {})).toThrow(/nothing to send/);
  });
});
