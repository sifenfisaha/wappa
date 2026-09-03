/**
 * Pure mapping between wappa's provider-agnostic chat model and the OpenAI
 * Chat Completions wire format. Kept free of I/O so it can be unit-tested
 * against fixtures without a client.
 */
import type {
  ChatMessage,
  GenerateResult,
  Logger,
  ToolCall,
  ToolSpec,
} from '@wappa/core';
import type {
  ChatCompletion,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

/**
 * Convert a wappa system prompt + history into Chat Completions messages.
 *
 * - `system` (when set) becomes the first message with role `'system'`.
 * - `user` messages pass through.
 * - `assistant` messages with `toolCalls` gain `tool_calls` entries whose
 *   `function.arguments` are JSON-stringified; empty text becomes `null` content.
 * - `tool` messages become `{ role: 'tool', tool_call_id, content }`.
 */
export function toOpenAIMessages(
  system: string | undefined,
  messages: ChatMessage[]
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  if (system !== undefined && system !== '') {
    out.push({ role: 'system', content: system });
  }
  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        out.push({ role: 'user', content: msg.content });
        break;
      case 'assistant':
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          out.push({
            role: 'assistant',
            // The API allows null content when tool_calls are present; an empty
            // string carries no information, so normalize it away.
            content: msg.content === '' ? null : msg.content,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          });
        } else {
          out.push({ role: 'assistant', content: msg.content });
        }
        break;
      case 'tool':
        out.push({
          role: 'tool',
          tool_call_id: msg.toolCallId ?? '',
          content: msg.content,
        });
        break;
    }
  }
  return out;
}

/**
 * Convert wappa tool specs into Chat Completions function tools.
 * `strict` is explicitly `false` — wappa tool schemas come from zod or raw JSON
 * Schema and are not guaranteed to satisfy structured-output restrictions.
 */
export function toOpenAITools(tools: ToolSpec[]): ChatCompletionFunctionTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    },
  }));
}

/**
 * Convert a Chat Completions response into a wappa {@link GenerateResult}.
 *
 * - Empty/absent message content maps to `text: null`.
 * - Function tool-call arguments are parsed from JSON; malformed or non-object
 *   payloads fall back to `{}` and are reported via `logger` (warn level).
 * - `finish_reason`: `stop`→`'stop'`, `tool_calls`→`'tool_calls'`,
 *   `length`→`'length'`, anything else (or a missing choice) →`'other'`.
 *
 * @param resp   Response from `chat.completions.create` (non-streaming).
 * @param logger Optional logger for malformed tool-call argument diagnostics.
 */
export function fromOpenAIResponse(resp: ChatCompletion, logger?: Logger): GenerateResult {
  const usage = resp.usage
    ? { inputTokens: resp.usage.prompt_tokens, outputTokens: resp.usage.completion_tokens }
    : undefined;

  const choice = resp.choices[0];
  if (!choice) {
    logger?.warn('@wappa/openai: response contained no choices');
    return { text: null, toolCalls: [], finishReason: 'other', ...(usage ? { usage } : {}) };
  }

  const content = choice.message.content;
  const text = content != null && content !== '' ? content : null;

  const toolCalls: ToolCall[] = [];
  for (const tc of choice.message.tool_calls ?? []) {
    if (tc.type !== 'function') {
      // Custom (non-function) tool calls can't map to wappa tools; skip them.
      logger?.debug('@wappa/openai: skipping non-function tool call', { type: tc.type });
      continue;
    }
    toolCalls.push({
      id: tc.id,
      name: tc.function.name,
      arguments: parseToolArguments(tc.function.arguments, tc.function.name, logger),
    });
  }

  return {
    text,
    toolCalls,
    finishReason: mapFinishReason(choice.finish_reason),
    ...(usage ? { usage } : {}),
  };
}

/** Map an OpenAI finish_reason onto wappa's closed set. */
function mapFinishReason(
  reason: ChatCompletion.Choice['finish_reason'] | null | undefined
): GenerateResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'other';
  }
}

/**
 * Parse a tool call's JSON `arguments` string. The model does not always emit
 * valid JSON; on any failure (or a non-object payload) return `{}` and log so
 * the agent loop keeps running and the tool's own validation can answer.
 */
function parseToolArguments(
  raw: string,
  toolName: string,
  logger?: Logger
): Record<string, unknown> {
  if (raw.trim() === '') return {}; // some compatible servers send '' for no-arg tools
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger?.warn('@wappa/openai: tool call arguments are not valid JSON; using {}', {
      tool: toolName,
      arguments: raw,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger?.warn('@wappa/openai: tool call arguments are not a JSON object; using {}', {
      tool: toolName,
      arguments: raw,
    });
    return {};
  }
  return parsed as Record<string, unknown>;
}
