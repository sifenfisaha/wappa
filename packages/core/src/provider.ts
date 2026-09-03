/**
 * Provider-agnostic LLM interface. The core owns the tool-call loop and conversation
 * memory; providers only map one `generate()` call to their SDK.
 *
 * There is no `system` role in {@link ChatMessage}: the system prompt travels separately
 * in {@link GenerateRequest.system} because every provider treats it specially.
 */

/** Conversation roles stored in session history. */
export type Role = 'user' | 'assistant' | 'tool';

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One message in the provider-agnostic conversation history. */
export interface ChatMessage {
  role: Role;
  /** Text content. Empty string allowed (e.g. assistant message that only calls tools). */
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on role 'tool' messages. */
  toolCallId?: string;
  toolName?: string;
}

/** JSON Schema object for tool parameters. */
export type JsonSchema = Record<string, unknown>;

/** Provider-facing tool description. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** One `generate()` call: system prompt, windowed history, tool specs, sampling options. */
export interface GenerateRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  temperature?: number;
}

/** Normalized model output for one `generate()` call. */
export interface GenerateResult {
  /** Final assistant text, or null if the model only called tools. */
  text: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** An LLM backend. Implementations map one request/response pair to their SDK. */
export interface Provider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
