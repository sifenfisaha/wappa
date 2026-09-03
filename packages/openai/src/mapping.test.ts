import { describe, expect, it } from 'vitest';
import type { ChatMessage, Logger } from '@wappa/core';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { fromOpenAIResponse, toOpenAIMessages, toOpenAITools } from './mapping.js';

/** Logger that records every call for assertions. */
function recordingLogger() {
  const entries: Array<{ level: string; msg: string; data?: object }> = [];
  const log = (level: string) => (msg: string, data?: object) => {
    entries.push(data === undefined ? { level, msg } : { level, msg, data });
  };
  const logger: Logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
  return { logger, entries };
}

/** Build a minimal ChatCompletion response fixture. */
function completion(overrides: {
  content?: string | null;
  tool_calls?: ChatCompletion.Choice['message']['tool_calls'];
  finish_reason?: ChatCompletion.Choice['finish_reason'];
  usage?: ChatCompletion['usage'];
  choices?: ChatCompletion['choices'];
}): ChatCompletion {
  const resp: ChatCompletion = {
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-5',
    choices: overrides.choices ?? [
      {
        index: 0,
        logprobs: null,
        finish_reason: overrides.finish_reason ?? 'stop',
        message: {
          role: 'assistant',
          refusal: null,
          content: overrides.content ?? null,
          ...(overrides.tool_calls ? { tool_calls: overrides.tool_calls } : {}),
        },
      },
    ],
  };
  if (overrides.usage) resp.usage = overrides.usage;
  return resp;
}

describe('toOpenAIMessages', () => {
  it('puts the system prompt first as a system-role message', () => {
    const out = toOpenAIMessages('You are helpful.', [{ role: 'user', content: 'hi' }]);
    expect(out).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('omits the system message when system is undefined or empty', () => {
    expect(toOpenAIMessages(undefined, [{ role: 'user', content: 'hi' }])).toEqual([
      { role: 'user', content: 'hi' },
    ]);
    expect(toOpenAIMessages('', [])).toEqual([]);
  });

  it('maps a multi-turn tool-use conversation exactly', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'weather in Addis?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Addis Ababa' } }],
      },
      { role: 'tool', content: '{"tempC":21}', toolCallId: 'call_1', toolName: 'get_weather' },
      { role: 'assistant', content: 'It is 21 C in Addis Ababa.' },
      { role: 'user', content: 'and tomorrow?' },
    ];
    expect(toOpenAIMessages('sys', history)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'weather in Addis?' },
      {
        role: 'assistant',
        content: null, // empty text normalized to null when tool_calls present
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Addis Ababa"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":21}' },
      { role: 'assistant', content: 'It is 21 C in Addis Ababa.' },
      { role: 'user', content: 'and tomorrow?' },
    ]);
  });

  it('keeps assistant text alongside tool_calls when non-empty', () => {
    const out = toOpenAIMessages(undefined, [
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [{ id: 'c1', name: 't', arguments: {} }],
      },
    ]);
    expect(out).toEqual([
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }],
      },
    ]);
  });

  it('stringifies nested tool-call arguments', () => {
    const out = toOpenAIMessages(undefined, [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 't', arguments: { a: [1, 2], b: { c: null } } }],
      },
    ]);
    const assistant = out[0] as Extract<(typeof out)[number], { role: 'assistant' }>;
    expect(assistant.tool_calls?.[0]).toMatchObject({
      function: { arguments: '{"a":[1,2],"b":{"c":null}}' },
    });
  });
});

describe('toOpenAITools', () => {
  it('maps ToolSpec to function tools with strict:false', () => {
    const parameters = { type: 'object', properties: { q: { type: 'string' } } };
    expect(
      toOpenAITools([{ name: 'search', description: 'Search things', parameters }])
    ).toEqual([
      {
        type: 'function',
        function: { name: 'search', description: 'Search things', parameters, strict: false },
      },
    ]);
  });
});

describe('fromOpenAIResponse', () => {
  it('maps a plain text response with usage', () => {
    const res = fromOpenAIResponse(
      completion({
        content: 'hello',
        finish_reason: 'stop',
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      })
    );
    expect(res).toEqual({
      text: 'hello',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 },
    });
  });

  it('omits usage when the response has none', () => {
    const res = fromOpenAIResponse(completion({ content: 'x' }));
    expect(res.usage).toBeUndefined();
  });

  it('maps tool calls, parsing JSON arguments', () => {
    const res = fromOpenAIResponse(
      completion({
        content: null,
        finish_reason: 'tool_calls',
        tool_calls: [
          {
            id: 'call_9',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris","days":2}' },
          },
        ],
      })
    );
    expect(res.text).toBeNull();
    expect(res.finishReason).toBe('tool_calls');
    expect(res.toolCalls).toEqual([
      { id: 'call_9', name: 'get_weather', arguments: { city: 'Paris', days: 2 } },
    ]);
  });

  it('falls back to {} and warns on malformed argument JSON', () => {
    const { logger, entries } = recordingLogger();
    const res = fromOpenAIResponse(
      completion({
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bad', arguments: '{"city": oops' } },
        ],
      }),
      logger
    );
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 'bad', arguments: {} }]);
    expect(entries.filter((e) => e.level === 'warn')).toHaveLength(1);
  });

  it('falls back to {} and warns on non-object argument JSON', () => {
    const { logger, entries } = recordingLogger();
    const res = fromOpenAIResponse(
      completion({
        finish_reason: 'tool_calls',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '[1,2]' } }],
      }),
      logger
    );
    expect(res.toolCalls[0]?.arguments).toEqual({});
    expect(entries.filter((e) => e.level === 'warn')).toHaveLength(1);
  });

  it('treats empty-string arguments as {} without warning', () => {
    const { logger, entries } = recordingLogger();
    const res = fromOpenAIResponse(
      completion({
        finish_reason: 'tool_calls',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '' } }],
      }),
      logger
    );
    expect(res.toolCalls).toEqual([{ id: 'c1', name: 't', arguments: {} }]);
    expect(entries.filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  it('skips non-function (custom) tool calls', () => {
    const res = fromOpenAIResponse(
      completion({
        finish_reason: 'tool_calls',
        tool_calls: [
          { id: 'c1', type: 'custom', custom: { name: 'x', input: 'y' } },
          { id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } },
        ],
      })
    );
    expect(res.toolCalls).toEqual([{ id: 'c2', name: 't', arguments: {} }]);
  });

  it.each([
    ['stop', 'stop'],
    ['tool_calls', 'tool_calls'],
    ['length', 'length'],
    ['content_filter', 'other'],
    ['function_call', 'other'],
  ] as const)('maps finish_reason %s -> %s', (from, to) => {
    expect(fromOpenAIResponse(completion({ content: 'x', finish_reason: from })).finishReason).toBe(
      to
    );
  });

  it('normalizes empty-string content to null text', () => {
    expect(fromOpenAIResponse(completion({ content: '' })).text).toBeNull();
  });

  it('handles a response with no choices without throwing', () => {
    const { logger, entries } = recordingLogger();
    const res = fromOpenAIResponse(completion({ choices: [] }), logger);
    expect(res).toEqual({ text: null, toolCalls: [], finishReason: 'other' });
    expect(entries.filter((e) => e.level === 'warn')).toHaveLength(1);
  });
});
