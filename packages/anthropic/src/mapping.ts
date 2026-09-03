/**
 * Pure mapping between wappa's provider-agnostic chat model and the Anthropic
 * Messages API. No I/O — these functions are unit-tested against fixtures.
 */
import type { Anthropic } from '@anthropic-ai/sdk';
import type { ChatMessage, GenerateResult, ToolCall, ToolSpec } from '@wappa/core';

/** The `system` + `messages` slice of an Anthropic `messages.create` request. */
export interface AnthropicMessagesParams {
  /** System prompt; omitted entirely when the request has none. */
  system?: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Convert wappa history to Anthropic request messages.
 *
 * - `user` messages pass through with string content.
 * - `assistant` messages with `toolCalls` become content blocks:
 *   a `text` block (only when content is non-empty) followed by one
 *   `tool_use` block per call.
 * - Consecutive `tool` messages merge into ONE `user` message of
 *   `tool_result` blocks, in order, with `tool_use_id` = `toolCallId`.
 *   An empty-string tool result omits the `content` key entirely — the API
 *   rejects an empty text block.
 * - `system` travels separately (the API takes it as a top-level param);
 *   the key is omitted when undefined.
 */
export function toAnthropicMessages(
  system: string | undefined,
  messages: ChatMessage[],
): AnthropicMessagesParams {
  const out: Anthropic.MessageParam[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === 'tool') {
      const blocks: Anthropic.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i]!.role === 'tool') {
        const toolMsg = messages[i]!;
        const block: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: toolMsg.toolCallId ?? '',
        };
        // The API rejects an empty text block; omit content for '' results.
        if (toolMsg.content !== '') block.content = toolMsg.content;
        blocks.push(block);
        i++;
      }
      out.push({ role: 'user', content: blocks });
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam> = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      out.push({ role: 'assistant', content: blocks });
      i++;
      continue;
    }
    out.push({ role: msg.role, content: msg.content });
    i++;
  }
  const params: AnthropicMessagesParams = { messages: out };
  if (system !== undefined) params.system = system;
  return params;
}

/**
 * Degrade tool-call history to plain text for a request made WITHOUT tools.
 *
 * The Messages API rejects `tool_use`/`tool_result` blocks when the request
 * carries no `tools` param (400), which broke the agent's maxTurns-exhaustion
 * fallback (a final generate without tools over tool-bearing history). Each
 * assistant `toolCalls` entry becomes text `[called <name>(<compact json
 * args>)]` appended to the assistant text; each `tool` message becomes a plain
 * user text message `[<toolName> result] <content>`. Ordering is preserved and
 * no tool blocks remain.
 */
export function degradeToolHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const parts: string[] = msg.content ? [msg.content] : [];
      for (const call of msg.toolCalls) {
        parts.push(`[called ${call.name}(${JSON.stringify(call.arguments)})]`);
      }
      return { role: 'assistant', content: parts.join('\n') };
    }
    if (msg.role === 'tool') {
      return { role: 'user', content: `[${msg.toolName ?? 'tool'} result] ${msg.content}` };
    }
    return msg;
  });
}

/** Convert wappa tool specs to Anthropic tool definitions. */
export function toAnthropicTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool['input_schema'],
  }));
}

/**
 * Convert an Anthropic response `Message` to a wappa {@link GenerateResult}.
 *
 * Text blocks are concatenated (`null` when there are none); `tool_use`
 * blocks become {@link ToolCall}s; `stop_reason` maps `end_turn` → `'stop'`,
 * `tool_use` → `'tool_calls'`, `max_tokens` → `'length'`, anything else →
 * `'other'`; usage comes from `response.usage`.
 */
export function fromAnthropicResponse(resp: Anthropic.Message): GenerateResult {
  let text: string | null = null;
  const toolCalls: ToolCall[] = [];
  for (const block of resp.content) {
    if (block.type === 'text') {
      text = (text ?? '') + block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: isRecord(block.input) ? block.input : {},
      });
    }
  }
  const result: GenerateResult = {
    text,
    toolCalls,
    finishReason: mapStopReason(resp.stop_reason),
  };
  if (resp.usage) {
    result.usage = {
      inputTokens: resp.usage.input_tokens,
      outputTokens: resp.usage.output_tokens,
    };
  }
  return result;
}

function mapStopReason(reason: Anthropic.StopReason | null): GenerateResult['finishReason'] {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'other';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
