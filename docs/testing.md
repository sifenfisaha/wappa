# Testing

Testability is a feature: `@wappa/core/testing` ships an in-memory transport and a
scripted provider so you can unit-test a complete bot — middleware, routes, agent loop,
tools, sessions — **offline**: no WhatsApp, no LLM key, fully deterministic.

```ts
import { MockTransport, ScriptedProvider } from '@wappa/core/testing';
```

## `MockTransport`

An in-memory `Transport` (`name: 'mock'`):

- `sent` — everything sent via `send()`, in order, as
  `Array<{ chatId: string; payload: OutboundPayload }>` (strings are normalized to
  `{ text }` via `toPayload`). Assert on it.
- `start()` fires `onReady({ selfId: 'mock' })` immediately.
- `receive(partial)` — simulate an inbound message. It **returns once the pipeline
  fully settles** (middleware, agent turn, session save included), so you can assert
  right after `await`ing it. You pass only what the test cares about; the defaults are
  exact and stable, so your tests can assert on them:

| Field       | Default                                          |
| ----------- | ------------------------------------------------ |
| `chatId`    | `'test-chat'`                                    |
| `senderId`  | = `chatId` (your override of `chatId` included)  |
| `id`        | `'msg-<n>'`, incrementing per transport instance (`msg-1`, `msg-2`, …) |
| `timestamp` | `Date.now()`                                     |
| `isGroup`   | `false`                                          |
| `fromMe`    | `false`                                          |

`MockTransport` implements no `sendTyping`, so the Bot's typing indicator is a silent
no-op in tests — `sent` contains only real messages.

## `ScriptedProvider`

A `Provider` (`name: 'scripted'`) that replays a script, one entry per `generate()`
call, and records every request in `calls: GenerateRequest[]` for inspection:

- A **string** entry is shorthand for `{ text: s, toolCalls: [], finishReason: 'stop' }`.
- A **partial `GenerateResult`** is completed with
  `{ text: null, toolCalls: [], finishReason: toolCalls.length ? 'tool_calls' : 'stop' }`
  — explicit fields win.
- A `generate()` call **past the end of the script rejects** with
  `Error('ScriptedProvider: script exhausted (call <n> of <len>)')` — a bot stuck in a
  loop fails loudly instead of hanging.

## A complete example

`src/bot.test.ts` — runnable with `vitest run`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, Bot, MemorySessionStore, defineTool, type InboundMessage } from '@wappa/core';
import { MockTransport, ScriptedProvider } from '@wappa/core/testing';

describe('order bot', () => {
  it('routes /ping without touching the agent', async () => {
    const transport = new MockTransport();
    const provider = new ScriptedProvider([]); // agent must not be called
    const bot = new Bot({
      transport,
      agent: new Agent({ instructions: 'You are a support bot.', provider }),
    });
    bot.command('/ping', (ctx) => void ctx.reply('pong'));
    await bot.start();

    await transport.receive({ text: '/ping' });

    expect(transport.sent).toEqual([{ chatId: 'test-chat', payload: { text: 'pong' } }]);
    expect(provider.calls).toHaveLength(0); // command matched — no LLM call
  });

  it('runs a scripted tool call end to end', async () => {
    const transport = new MockTransport();
    const provider = new ScriptedProvider([
      // Call 1: the model asks for a tool.
      { toolCalls: [{ id: 'call_1', name: 'check_order_status', arguments: { orderId: 'A-1001' } }] },
      // Call 2: the model answers using the tool result.
      'Your order A-1001 has shipped.',
    ]);
    const sessions = new MemorySessionStore();
    const bot = new Bot({
      transport,
      sessions,
      agent: new Agent({
        instructions: 'You are a support bot.',
        provider,
        tools: [
          defineTool({
            name: 'check_order_status',
            description: 'Look up an order by id.',
            parameters: z.object({ orderId: z.string() }),
            execute: ({ orderId }) => ({ orderId, status: 'shipped' }),
          }),
        ],
      }),
    });
    await bot.start();

    await transport.receive({ text: 'Where is my order A-1001?' });

    // The reply went out to the default chat.
    expect(transport.sent).toEqual([
      { chatId: 'test-chat', payload: { text: 'Your order A-1001 has shipped.' } },
    ]);

    // The provider saw two requests; the second carried the tool result.
    expect(provider.calls).toHaveLength(2);
    const lastMessage = provider.calls[1]!.messages.at(-1)!;
    expect(lastMessage).toEqual({
      role: 'tool',
      content: '{"orderId":"A-1001","status":"shipped"}', // objects are JSON-stringified
      toolCallId: 'call_1',
      toolName: 'check_order_status',
    });

    // Session history: user, assistant(toolCalls), tool result, final assistant.
    const session = await sessions.get('test-chat');
    expect(session?.history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('applies the documented receive() defaults', async () => {
    const transport = new MockTransport();
    const bot = new Bot({ transport }); // router-only bot — no agent needed
    // Capture inside the handler, assert outside: the pipeline routes handler
    // errors to onError, so a failing expect() inside would be swallowed.
    let seen: InboundMessage | undefined;
    bot.command('/whoami', (ctx) => {
      seen = ctx.message;
    });
    await bot.start();

    await transport.receive({ text: '/whoami' });

    expect(seen).toMatchObject({
      id: 'msg-1',            // first receive() on this transport instance
      chatId: 'test-chat',
      senderId: 'test-chat',  // senderId defaults to chatId
      isGroup: false,
      fromMe: false,
      text: '/whoami',
    });
  });
});
```

## Patterns worth stealing

- **Assert on `provider.calls`** to verify what the model was shown: the windowed
  history, the tool specs (`calls[0].tools`), the rendered user message (group messages
  arrive prefixed `sender: text`), the system prompt.
- **Override only what matters** in `receive()`: `{ text, chatId: 'other-chat' }` to
  test per-chat isolation, `{ isGroup: true, senderId: 'member@g.us', senderName: 'Ada' }`
  for group behavior, `{ fromMe: true }` to check the drop filter.
- **Inject a `SessionStore` you keep a reference to** (as above) to assert on history
  and `session.data` after a turn — or use a `FileSessionStore` on a temp dir to test
  persistence for real.
- **Keep scripts minimal.** The exhaustion error means a surplus `generate()` call fails
  the test with a precise message instead of hanging or silently passing.
- **Test tools directly, too.** `defineTool(...)` returns a `Tool` whose
  `invoke(args, ctx)` you can call with a stub context — no bot required — and whose
  error behavior (invalid args, thrown errors) comes back as result strings.
