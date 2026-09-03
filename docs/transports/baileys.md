# Baileys transport (`@wappa/baileys`)

`BaileysTransport` runs your bot on a **personal WhatsApp number** through
[Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client.
You log in by scanning a QR code, exactly like linking a browser session.

> **Legal / ToS warning.** Baileys is an unofficial client: using it may violate
> WhatsApp's Terms of Service and **can get phone numbers banned**. Use a number you can
> afford to lose, and prefer the official Cloud API transport
> ([`@wappa/cloud-api`](cloud-api.md)) for production.

## Usage

```ts
import { Bot } from '@wappa/core';
import { BaileysTransport } from '@wappa/baileys';

const transport = new BaileysTransport({
  authDir: './wappa-auth',   // default — directory for multi-file auth state
  printQR: true,            // default — print the QR to the terminal on login
  onQR: (qr) => { /* raw QR string, for custom rendering */ },
  logger,                   // wappa Logger for adapter logs; default consoleLogger()
  baileysLogLevel: 'silent',// default — Baileys' own (pino) log level
});

const bot = new Bot({ transport /*, agent, ... */ });
await bot.start();
```

All options are optional; `new BaileysTransport()` works.

## The QR flow, and what `start()` means

`start()` resolves **when the socket is created, not when you are logged in**. The QR
flow keeps running after it resolves:

1. `await bot.start()` returns; a QR code is printed to the terminal (and/or `onQR` is
   called with the raw string). A fresh QR is emitted each time WhatsApp rotates it.
2. On your phone: WhatsApp → Settings → Linked devices → Link a device → scan.
3. When the connection opens, the transport fires `onReady` — `bot.on('ready', ...)`
   fires and `bot.selfId` is set from the socket's own user id (a JID like
   `15551234567:3@s.whatsapp.net`).

Don't send proactively before `'ready'` — see "Sending while disconnected" below.

## Auth persistence

Credentials are stored via Baileys' multi-file auth state in `authDir`
(default `./wappa-auth` — keep it out of version control; this repo's `.gitignore`
already ignores `wappa-auth/`). Credential updates are persisted automatically whenever
Baileys rotates keys, so the QR scan is a **one-time** step: subsequent starts reconnect
silently from the stored state.

Treat the auth directory as a secret — anyone holding it can act as your WhatsApp
account. That is why the transport creates the directory with owner-only permissions
(**0700**) and tightens an existing one to the same on start: `creds.json` is full
account-takeover material and must never be world-readable on shared hosts. To unlink
and start over, delete the directory and scan again.

## Reconnect policy

On connection close the transport reconnects automatically with capped exponential
backoff: 1s, 2s, 4s, … doubling per attempt, capped at 30s. The attempt counter resets
on every successful open.

The one exception is a `loggedOut` disconnect (you unlinked the device or WhatsApp
terminated the session): the transport does **not** reconnect, logs a warning, and fires
`onDisconnect('loggedOut')` — handle it with `bot.on('disconnect', ...)`. Delete the
auth dir and restart to relink. `stop()` also cancels any pending reconnect.

## Sending while disconnected

`send()` and `markRead()` while disconnected or mid-reconnect **reject** with
`Error('BaileysTransport: not connected')` — there is no internal outbound queueing
in v0.1. For replies inside the pipeline the rejection surfaces through the Bot's
`onError`; for proactive `bot.send(...)` calls, catch it yourself and retry after
`'ready'`.

`sendTyping` is the exception: it is **best-effort** and returns silently (with a debug
log) when there is no connected socket — e.g. mid-reconnect — so a typing indicator
never kills an agent turn that would have succeeded after the reconnect.

## What gets mapped inbound

Only real `messages.upsert` events of type `notify` are delivered. For each message:

- text (`conversation` / extended text) → `message.text`
- image/video/audio/document/sticker → `message.media` (a lazy `MediaRef`; `download()`
  fetches the bytes via Baileys, and voice notes have `ptt: true`); the caption becomes
  `message.text`
- location → `message.location`; reaction → `message.reaction`; quoted context →
  `message.quoted`
- `chatId` is the JID; `isGroup` is true for `...@g.us` chats; `senderId` is the group
  participant JID (or the chat JID in DMs); `senderName` comes from the push name;
  the raw Baileys message is kept on `message.raw` as an escape hatch

Protocol/system messages, polls, contacts, status broadcasts (`status@broadcast` is
not a conversation a bot can reply into), `@newsletter` jids (WhatsApp Channels posts —
not DMs a bot should answer) and anything else without mappable content are skipped
silently. Wrapper envelopes (ephemeral, view-once, edited, device-sent) are unwrapped
to their inner content first.

## Outbound behavior

`bot.send` / `ctx.reply` accept a string or an `OutboundPayload`:

- **Text** → plain text message.
- **Media** — `data` may be a Buffer, an `https:` URL, or a local file path.
  image/video/document carry a caption (`media.caption ?? payload.text`); audio supports
  `ptt: true` for voice notes; audio/sticker carry no caption and location carries no
  text, so text alongside those is dropped.
- **Buttons** — Baileys has no native quick-reply buttons, so the transport renders a
  **numbered text fallback** appended to the text:

  ```
  Which topping?

  1. Cheese
  2. Pepperoni
  ```

  The user answers with plain text (the number or the title) — `buttonId` never
  round-trips on Baileys. Portable button handling should therefore match on the
  **title** via `hears()`; see the note on `OutboundButton` in the core message model.
- **`replyTo`** is skipped (with a debug log): Baileys quoting requires the original
  message object, which the transport does not retain. The message is sent unquoted
  rather than failing.
- `sendTyping` maps to a presence update (`composing`/`paused`); `markRead` marks the
  message read.

## Stopping

`transport.stop()` (or `bot.stop()`) closes the socket **without logging out** — the
auth state stays valid for the next start. Idempotent.
