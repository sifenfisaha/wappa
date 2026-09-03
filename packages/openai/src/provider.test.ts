import { describe, expect, it } from 'vitest';
import type { ChatMessage, Logger, ToolSpec } from '@wappa/core';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import { OpenAIProvider, type OpenAIChatClient } from './index.js';

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

/** Fake client that records every request body and replays scripted responses. */
function fakeClient(responses: ChatCompletion[]) {
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  const client: OpenAIChatClient = {
    chat: {
      completions: {
        create: async (params) => {
          requests.push(params);
          const next = responses.shift();
          if (!next) throw new Error('fakeClient: no scripted response left');
          return next;
        },
      },
    },
  };
  return { client, requests };
}

function textResponse(
  content: string,
  finish: ChatCompletion.Choice['finish_reason'] = 'stop'
): ChatCompletion {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-5',
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: finish,
        message: { role: 'assistant', refusal: null, content },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function toolCallResponse(): ChatCompletion {
  return {
    id: 'chatcmpl-2',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-5',
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          refusal: null,
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
      },
    ],
  };
}

const weatherTool: ToolSpec = {
  name: 'get_weather',
  description: 'Get current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

describe('OpenAIProvider', () => {
  it('is named openai', () => {
    const { client } = fakeClient([]);
    expect(new OpenAIProvider({ client }).name).toBe('openai');
  });

  it('sends the exact request body for a full request (non-reasoning model)', async () => {
    const { client, requests } = fakeClient([textResponse('sunny')]);
    const provider = new OpenAIProvider({ client, model: 'gpt-4o' });
    const messages: ChatMessage[] = [{ role: 'user', content: 'weather in Paris?' }];

    const res = await provider.generate({
      system: 'You are a weather bot.',
      messages,
      tools: [weatherTool],
      maxTokens: 512,
      temperature: 0.3,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a weather bot.' },
        { role: 'user', content: 'weather in Paris?' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: weatherTool.parameters,
            strict: false,
          },
        },
      ],
      max_completion_tokens: 512,
      temperature: 0.3,
    });
    expect(res).toEqual({
      text: 'sunny',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('omits tools, max_completion_tokens and temperature when unset', async () => {
    const { client, requests } = fakeClient([textResponse('hi')]);
    await new OpenAIProvider({ client }).generate({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(requests[0]).toEqual({
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'low', // gpt-5 is a reasoning model; default effort
    });
  });

  it('omits the tools key for an empty tools array', async () => {
    const { client, requests } = fakeClient([textResponse('hi')]);
    await new OpenAIProvider({ client }).generate({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    expect(requests[0]).not.toHaveProperty('tools');
  });

  it('uses the configured model', async () => {
    const { client, requests } = fakeClient([textResponse('ok')]);
    await new OpenAIProvider({ client, model: 'llama3.2' }).generate({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(requests[0]?.model).toBe('llama3.2');
  });

  it('drops temperature for the default model (gpt-5) and warns once across two calls', async () => {
    const { client, requests } = fakeClient([textResponse('a'), textResponse('b')]);
    const { logger, entries } = recordingLogger();
    const provider = new OpenAIProvider({ client, logger });

    await provider.generate({ messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 });
    await provider.generate({ messages: [{ role: 'user', content: 'again' }], temperature: 0.7 });

    expect(requests).toHaveLength(2);
    expect(requests[0]).not.toHaveProperty('temperature');
    expect(requests[1]).not.toHaveProperty('temperature');
    const warns = entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.msg).toContain('gpt-5 does not support temperature; ignoring');
  });

  it.each(['o1-preview', 'o3-mini', 'o4-mini'])(
    'drops temperature for reasoning model %s',
    async (model) => {
      const { client, requests } = fakeClient([textResponse('ok')]);
      const { logger, entries } = recordingLogger();
      await new OpenAIProvider({ client, logger, model }).generate({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
      });
      expect(requests[0]).not.toHaveProperty('temperature');
      expect(entries.filter((e) => e.level === 'warn')).toHaveLength(1);
    }
  );

  it.each(['gpt-4o', 'gpt-5-chat-latest'])(
    'forwards temperature for non-reasoning model %s without warning',
    async (model) => {
      const { client, requests } = fakeClient([textResponse('ok')]);
      const { logger, entries } = recordingLogger();
      await new OpenAIProvider({ client, logger, model }).generate({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
      });
      expect(requests[0]?.temperature).toBe(0.3);
      expect(entries.filter((e) => e.level === 'warn')).toHaveLength(0);
    }
  );

  it("sends reasoning_effort 'low' by default for gpt-5", async () => {
    const { client, requests } = fakeClient([textResponse('ok')]);
    await new OpenAIProvider({ client }).generate({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(requests[0]?.reasoning_effort).toBe('low');
  });

  it('sends the configured reasoningEffort for a reasoning model', async () => {
    const { client, requests } = fakeClient([textResponse('ok')]);
    await new OpenAIProvider({ client, reasoningEffort: 'high' }).generate({
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(requests[0]?.reasoning_effort).toBe('high');
  });

  it.each(['gpt-4o', 'gpt-5-chat-latest', 'llama3.2'])(
    'never sends reasoning_effort for non-reasoning model %s',
    async (model) => {
      const { client, requests } = fakeClient([textResponse('ok')]);
      await new OpenAIProvider({ client, model, reasoningEffort: 'high' }).generate({
        messages: [{ role: 'user', content: 'hi' }],
      });
      expect(requests[0]).not.toHaveProperty('reasoning_effort');
    }
  );

  it("warns every time a response finishes with 'length' and no text", async () => {
    const { client } = fakeClient([textResponse('', 'length'), textResponse('', 'length')]);
    const { logger, entries } = recordingLogger();
    const provider = new OpenAIProvider({ client, logger });

    const res = await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });
    await provider.generate({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.text).toBeNull();
    expect(res.finishReason).toBe('length');
    const warns = entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(2);
    expect(warns[0]!.msg).toContain('completion budget exhausted before any output');
    expect(warns[0]!.msg).toContain('raising maxTokens');
  });

  it("does not warn on 'length' when the response has text", async () => {
    const { client } = fakeClient([textResponse('truncat', 'length')]);
    const { logger, entries } = recordingLogger();

    const res = await new OpenAIProvider({ client, logger }).generate({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.finishReason).toBe('length');
    expect(res.text).toBe('truncat');
    expect(entries.filter((e) => e.level === 'warn')).toHaveLength(0);
  });

  it('runs a full tool round-trip end to end', async () => {
    const { client, requests } = fakeClient([toolCallResponse(), textResponse('21 C in Paris')]);
    const provider = new OpenAIProvider({ client });

    // Turn 1: model asks for a tool.
    const first = await provider.generate({
      system: 'sys',
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: [weatherTool],
    });
    expect(first.text).toBeNull();
    expect(first.finishReason).toBe('tool_calls');
    expect(first.toolCalls).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } },
    ]);

    // Turn 2: history extended with the assistant tool call + tool result,
    // the way the core agent loop does it.
    const second = await provider.generate({
      system: 'sys',
      messages: [
        { role: 'user', content: 'weather in Paris?' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', content: '{"tempC":21}', toolCallId: 'call_1', toolName: 'get_weather' },
      ],
      tools: [weatherTool],
    });

    expect(second.text).toBe('21 C in Paris');
    expect(requests[1]?.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'weather in Paris?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":21}' },
    ]);
  });

  it('propagates client errors', async () => {
    const { client } = fakeClient([]); // script exhausted -> create throws
    await expect(
      new OpenAIProvider({ client }).generate({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('no scripted response left');
  });

  it('constructs a real SDK client from apiKey/baseURL without a network call', () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-test',
      baseURL: 'http://localhost:11434/v1',
      model: 'llama3.2',
    });
    expect(provider.name).toBe('openai');
  });
});
