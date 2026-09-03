import { describe, expect, it, vi } from 'vitest';
import type { WAMessage } from 'baileys';
import {
  extractMediaInfo,
  extractQuoted,
  extractText,
  mapMessage,
  renderButtonFallback,
  toBaileysContent,
  unwrapContent,
} from './mapping.js';

/** Downloader stub that must never be called eagerly. */
const noDownload = vi.fn<(msg: WAMessage) => Promise<Buffer>>(() =>
  Promise.reject(new Error('unexpected download'))
);

function textMessage(overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { remoteJid: '123456789@s.whatsapp.net', fromMe: false, id: 'ABCDEF123' },
    message: { conversation: 'hello' },
    messageTimestamp: 1700000000,
    pushName: 'Alice',
    ...overrides,
  } as WAMessage;
}

describe('mapMessage', () => {
  it('maps a plain conversation message', () => {
    const msg = textMessage();
    const mapped = mapMessage(msg, noDownload);
    expect(mapped).toEqual({
      id: 'ABCDEF123',
      chatId: '123456789@s.whatsapp.net',
      senderId: '123456789@s.whatsapp.net',
      senderName: 'Alice',
      timestamp: 1700000000000,
      isGroup: false,
      fromMe: false,
      text: 'hello',
      raw: msg,
    });
  });

  it('maps extendedTextMessage text and its quoted context', () => {
    const msg = textMessage({
      message: {
        extendedTextMessage: {
          text: 'replying to you',
          contextInfo: {
            stanzaId: 'orig-1',
            participant: '999@s.whatsapp.net',
            quotedMessage: { conversation: 'original text' },
          },
        },
      },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.text).toBe('replying to you');
    expect(mapped?.quoted).toEqual({
      id: 'orig-1',
      text: 'original text',
      senderId: '999@s.whatsapp.net',
    });
  });

  it('maps group messages: chatId is the group, senderId the participant', () => {
    const msg = textMessage({
      key: {
        remoteJid: '12036302@g.us',
        fromMe: false,
        id: 'GRP1',
        participant: '777@s.whatsapp.net',
      },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.isGroup).toBe(true);
    expect(mapped?.chatId).toBe('12036302@g.us');
    expect(mapped?.senderId).toBe('777@s.whatsapp.net');
  });

  it('maps fromMe', () => {
    const msg = textMessage({
      key: { remoteJid: '123@s.whatsapp.net', fromMe: true, id: 'MINE1' },
    });
    expect(mapMessage(msg, noDownload)?.fromMe).toBe(true);
  });

  it('maps an image message: media ref, caption as text, lazy download', async () => {
    const msg = textMessage({
      message: {
        imageMessage: {
          caption: 'look at this',
          mimetype: 'image/jpeg',
          url: 'https://mmg.whatsapp.net/d/f/x',
          mediaKey: new Uint8Array([1, 2, 3]),
          fileLength: 1234,
        },
      },
    });
    const buffer = Buffer.from('image-bytes');
    const download = vi.fn<(m: WAMessage) => Promise<Buffer>>(() => Promise.resolve(buffer));
    const mapped = mapMessage(msg, download);
    expect(mapped?.text).toBe('look at this');
    expect(mapped?.media?.kind).toBe('image');
    expect(mapped?.media?.mimetype).toBe('image/jpeg');
    expect(download).not.toHaveBeenCalled();
    await expect(mapped!.media!.download()).resolves.toBe(buffer);
    expect(download).toHaveBeenCalledWith(msg);
  });

  it('maps a voice note: kind audio with ptt', () => {
    const msg = textMessage({
      message: {
        audioMessage: { ptt: true, mimetype: 'audio/ogg; codecs=opus', seconds: 4 },
      },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.media).toMatchObject({
      kind: 'audio',
      ptt: true,
      mimetype: 'audio/ogg; codecs=opus',
    });
    expect(mapped?.text).toBeUndefined();
  });

  it('maps a document: filename, mimetype, caption', () => {
    const msg = textMessage({
      message: {
        documentMessage: {
          fileName: 'report.pdf',
          mimetype: 'application/pdf',
          caption: 'the report',
        },
      },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.media).toMatchObject({
      kind: 'document',
      filename: 'report.pdf',
      mimetype: 'application/pdf',
    });
    expect(mapped?.text).toBe('the report');
  });

  it('maps a sticker', () => {
    const msg = textMessage({
      message: { stickerMessage: { mimetype: 'image/webp' } },
    });
    expect(mapMessage(msg, noDownload)?.media?.kind).toBe('sticker');
  });

  it('maps a video with caption', () => {
    const msg = textMessage({
      message: { videoMessage: { caption: 'clip', mimetype: 'video/mp4' } },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.media?.kind).toBe('video');
    expect(mapped?.text).toBe('clip');
  });

  it('maps a location message', () => {
    const msg = textMessage({
      message: {
        locationMessage: {
          degreesLatitude: 9.0301,
          degreesLongitude: 38.7408,
          name: 'Addis Ababa',
          address: 'Ethiopia',
        },
      },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.location).toEqual({
      latitude: 9.0301,
      longitude: 38.7408,
      name: 'Addis Ababa',
      address: 'Ethiopia',
    });
    expect(mapped?.text).toBeUndefined();
  });

  it('maps a reaction message', () => {
    const msg = textMessage({
      message: {
        reactionMessage: {
          text: '\u{1F44D}',
          key: { remoteJid: '123456789@s.whatsapp.net', fromMe: false, id: 'target-1' },
        },
      },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.reaction).toEqual({ emoji: '\u{1F44D}', targetMessageId: 'target-1' });
    expect(mapped?.text).toBeUndefined();
  });

  it('unwraps ephemeral messages', () => {
    const msg = textMessage({
      message: { ephemeralMessage: { message: { conversation: 'disappearing' } } },
    });
    expect(mapMessage(msg, noDownload)?.text).toBe('disappearing');
  });

  it('unwraps viewOnceMessageV2 media', () => {
    const msg = textMessage({
      message: {
        viewOnceMessageV2: {
          message: { imageMessage: { caption: 'once', mimetype: 'image/jpeg' } },
        },
      },
    });
    const mapped = mapMessage(msg, noDownload);
    expect(mapped?.media?.kind).toBe('image');
    expect(mapped?.text).toBe('once');
  });

  it('skips protocol messages silently', () => {
    const msg = textMessage({ message: { protocolMessage: { type: 0 } } });
    expect(mapMessage(msg, noDownload)).toBeUndefined();
  });

  it('skips messages with no content (system/stub)', () => {
    const msg = textMessage({ message: undefined });
    expect(mapMessage(msg, noDownload)).toBeUndefined();
  });

  it('skips unmapped content types (e.g. polls)', () => {
    const msg = textMessage({
      message: { pollCreationMessage: { name: 'poll?', options: [] } },
    });
    expect(mapMessage(msg, noDownload)).toBeUndefined();
  });

  it('skips messages without a chat jid or id', () => {
    expect(mapMessage(textMessage({ key: { id: 'X1' } }), noDownload)).toBeUndefined();
    expect(
      mapMessage(textMessage({ key: { remoteJid: '1@s.whatsapp.net' } }), noDownload)
    ).toBeUndefined();
  });

  it('skips status broadcasts', () => {
    const msg = textMessage({
      key: { remoteJid: 'status@broadcast', fromMe: false, id: 'S1' },
    });
    expect(mapMessage(msg, noDownload)).toBeUndefined();
  });

  it('skips newsletter (WhatsApp Channel) posts', () => {
    const msg = textMessage({
      key: { remoteJid: '120363123456789012@newsletter', fromMe: false, id: 'N1' },
    });
    expect(mapMessage(msg, noDownload)).toBeUndefined();
  });

  it('converts Long-like timestamps to ms', () => {
    const longLike = { toString: () => '1700000001' };
    const msg = textMessage({ messageTimestamp: longLike as never });
    expect(mapMessage(msg, noDownload)?.timestamp).toBe(1700000001000);
  });

  it('falls back to Date.now() for a missing timestamp', () => {
    const before = Date.now();
    const mapped = mapMessage(textMessage({ messageTimestamp: undefined }), noDownload);
    expect(mapped!.timestamp).toBeGreaterThanOrEqual(before);
    expect(mapped!.timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('unwrapContent / extractText / extractMediaInfo / extractQuoted', () => {
  it('unwraps nested wrappers down to real content', () => {
    expect(
      unwrapContent({
        ephemeralMessage: {
          message: { viewOnceMessage: { message: { conversation: 'deep' } } },
        },
      })
    ).toEqual({ conversation: 'deep' });
  });

  it('returns undefined for empty content', () => {
    expect(unwrapContent(undefined)).toBeUndefined();
    expect(unwrapContent(null)).toBeUndefined();
  });

  it('extractText reads body, extended text, and captions', () => {
    expect(extractText({ conversation: 'a' })).toBe('a');
    expect(extractText({ extendedTextMessage: { text: 'b' } })).toBe('b');
    expect(extractText({ imageMessage: { caption: 'c' } })).toBe('c');
    expect(extractText({ protocolMessage: {} })).toBeUndefined();
  });

  it('extractMediaInfo returns undefined for non-media', () => {
    expect(extractMediaInfo({ conversation: 'x' })).toBeUndefined();
  });

  it('extractQuoted requires a stanzaId', () => {
    expect(
      extractQuoted({ extendedTextMessage: { text: 'x', contextInfo: {} } })
    ).toBeUndefined();
  });
});

describe('renderButtonFallback', () => {
  const buttons = [
    { id: 'a', title: 'Title A' },
    { id: 'b', title: 'Title B' },
  ];

  it('appends a numbered list to the text (exact spec format)', () => {
    expect(renderButtonFallback('Pick one', buttons)).toBe('Pick one\n\n1. Title A\n2. Title B');
  });

  it('renders only the numbered list without text', () => {
    expect(renderButtonFallback(undefined, buttons)).toBe('1. Title A\n2. Title B');
  });
});

describe('toBaileysContent', () => {
  it('maps plain text', () => {
    expect(toBaileysContent({ text: 'hi' })).toEqual({ text: 'hi' });
  });

  it('renders buttons as the numbered text fallback', () => {
    expect(
      toBaileysContent({
        text: 'Pick one',
        buttons: [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'No' },
          { id: 'maybe', title: 'Maybe' },
        ],
      })
    ).toEqual({ text: 'Pick one\n\n1. Yes\n2. No\n3. Maybe' });
  });

  it('renders buttons without text as the list alone', () => {
    expect(toBaileysContent({ buttons: [{ id: 'a', title: 'A' }] })).toEqual({ text: '1. A' });
  });

  it('maps image media from a Buffer with caption and mimetype', () => {
    const data = Buffer.from('img');
    expect(
      toBaileysContent({
        media: { kind: 'image', data, caption: 'cap', mimetype: 'image/png' },
      })
    ).toEqual({ image: data, caption: 'cap', mimetype: 'image/png' });
  });

  it('maps media from a URL string to the { url } form', () => {
    expect(
      toBaileysContent({ media: { kind: 'video', data: 'https://example.com/v.mp4' } })
    ).toEqual({ video: { url: 'https://example.com/v.mp4' }, caption: undefined, mimetype: undefined });
  });

  it('maps media from a local file path to the { url } form', () => {
    const content = toBaileysContent({ media: { kind: 'image', data: '/tmp/pic.jpg' } });
    expect(content).toMatchObject({ image: { url: '/tmp/pic.jpg' } });
  });

  it('uses payload.text as the caption when media.caption is absent', () => {
    const content = toBaileysContent({
      text: 'caption me',
      media: { kind: 'image', data: Buffer.from('x') },
    });
    expect(content).toMatchObject({ caption: 'caption me' });
  });

  it('appends the button fallback to a captionable media caption', () => {
    const content = toBaileysContent({
      media: { kind: 'image', data: Buffer.from('x'), caption: 'Pick' },
      buttons: [{ id: 'a', title: 'A' }],
    });
    expect(content).toMatchObject({ caption: 'Pick\n\n1. A' });
  });

  it('maps audio with ptt', () => {
    const data = Buffer.from('ogg');
    expect(toBaileysContent({ media: { kind: 'audio', data, ptt: true } })).toEqual({
      audio: data,
      ptt: true,
      mimetype: undefined,
    });
  });

  it('maps a sticker', () => {
    const data = Buffer.from('webp');
    expect(toBaileysContent({ media: { kind: 'sticker', data } })).toEqual({
      sticker: data,
      mimetype: undefined,
    });
  });

  it('maps a document with a default mimetype and fileName', () => {
    const data = Buffer.from('pdf');
    expect(
      toBaileysContent({ media: { kind: 'document', data, filename: 'a.pdf' } })
    ).toEqual({
      document: data,
      mimetype: 'application/octet-stream',
      fileName: 'a.pdf',
      caption: undefined,
    });
  });

  it('maps a location', () => {
    expect(
      toBaileysContent({
        location: { latitude: 1.5, longitude: -2.5, name: 'Spot', address: 'Street 1' },
      })
    ).toEqual({
      location: {
        degreesLatitude: 1.5,
        degreesLongitude: -2.5,
        name: 'Spot',
        address: 'Street 1',
      },
    });
  });

  it('prefers media over location over text', () => {
    const data = Buffer.from('x');
    const content = toBaileysContent({
      text: 't',
      media: { kind: 'sticker', data },
      location: { latitude: 0, longitude: 0 },
    });
    expect(content).toMatchObject({ sticker: data });
  });

  it('throws on an empty payload', () => {
    expect(() => toBaileysContent({})).toThrow(/no sendable content/);
  });
});
