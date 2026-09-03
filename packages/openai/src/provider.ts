/**
 * OpenAI provider for wappa, built on the Chat Completions API for maximum
 * compatibility with OpenAI-compatible servers (Ollama, vLLM, llama.cpp, ...)
 * via `baseURL`.
 */
import OpenAI from 'openai';
import {
  consoleLogger,
  type GenerateRequest,
  type GenerateResult,
  type Logger,
  type Provider,
} from '@wappa/core';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import { fromOpenAIResponse, toOpenAIMessages, toOpenAITools } from './mapping.js';

/** Model-id prefixes of OpenAI's reasoning model families. */
const REASONING_MODEL_PREFIXES = ['gpt-5', 'o1', 'o3', 'o4'];

/**
 * Whether `model` is a reasoning-family model (`gpt-5*`, `o1*`, `o3*`, `o4*`).
 * The `*-chat-latest` variants are NOT reasoning models — they behave like
 * regular chat models and accept sampling params.
 */
function isReasoningModel(model: string): boolean {
  if (model.endsWith('-chat-latest')) return false;
  return REASONING_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

/**
 * Structural subset of the OpenAI SDK client used by {@link OpenAIProvider}.
 * The real `OpenAI` instance satisfies it; tests inject a fake.
 *
 * @internal
 */
export interface OpenAIChatClient {
  chat: {
    completions: {
      create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;
    };
  };
}

/** Options for {@link OpenAIProvider}. */
export interface OpenAIProviderOptions {
  /** API key. Defaults to the `OPENAI_API_KEY` environment variable (SDK default). */
  apiKey?: string;
  /**
   * Model id. Default `'gpt-5'`.
   *
   * Reasoning-family models (`gpt-5*`, `o1*`, `o3*`, `o4*`, excluding the
   * `*-chat-latest` variants) reject non-default `temperature` with 400; for
   * those the provider drops `temperature` and warns once per instance. All
   * other models (`gpt-4o`, `*-chat-latest`, custom `baseURL` models) receive
   * it unchanged.
   */
  model?: string;
  /** API base URL override — point this at Ollama or any OpenAI-compatible server. */
  baseURL?: string;
  /**
   * Reasoning effort sent as `reasoning_effort` for reasoning-family models
   * (`gpt-5*`, `o1*`, `o3*`, `o4*`, excluding `*-chat-latest`). Default
   * `'low'` — the API default effort can burn the whole completion budget
   * (`max_completion_tokens`) on hidden reasoning tokens and return an empty
   * response. Never sent for non-reasoning models, since some
   * OpenAI-compatible servers reject unknown params.
   */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Extra options passed to the OpenAI client constructor (timeout, fetch, ...).
   * `apiKey` and `baseURL` above take precedence on conflict.
   */
  clientOptions?: ConstructorParameters<typeof OpenAI>[0];
  /**
   * Logger for adapter diagnostics (e.g. malformed tool-call arguments,
   * dropped sampling params, exhausted completion budgets).
   * Default: `consoleLogger()`.
   */
  logger?: Logger;
  /**
   * Injected client replacing the real OpenAI SDK client — for tests.
   *
   * @internal
   */
  client?: OpenAIChatClient;
}

/**
 * wappa {@link Provider} backed by the OpenAI Chat Completions API.
 *
 * Token limits are sent as `max_completion_tokens` (the current parameter,
 * required by reasoning-capable models such as the default `gpt-5`; the legacy
 * `max_tokens` is rejected by those models). For reasoning-family models the
 * provider sends `reasoning_effort` (default `'low'`, see
 * {@link OpenAIProviderOptions.reasoningEffort}) and drops `temperature`
 * (those models 400 on it) with a one-time warning; when a response comes
 * back with `finishReason 'length'` and no text, it warns that the completion
 * budget was exhausted before any output.
 */
export class OpenAIProvider implements Provider {
  readonly name = 'openai';

  private readonly client: OpenAIChatClient;
  private readonly model: string;
  private readonly logger: Logger;
  private readonly reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | undefined;
  private warnedTemperature = false;

  constructor(opts: OpenAIProviderOptions = {}) {
    this.model = opts.model ?? 'gpt-5';
    this.logger = opts.logger ?? consoleLogger();
    this.reasoningEffort = opts.reasoningEffort;
    this.client =
      opts.client ??
      new OpenAI({
        ...opts.clientOptions,
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      });
  }

  /** Run one non-streaming Chat Completions call and map the result. */
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const reasoning = isReasoningModel(this.model);
    const params: ChatCompletionCreateParamsNonStreaming = {
      model: this.model,
      messages: toOpenAIMessages(req.system, req.messages),
    };
    if (req.tools && req.tools.length > 0) params.tools = toOpenAITools(req.tools);
    if (req.maxTokens !== undefined) params.max_completion_tokens = req.maxTokens;
    if (req.temperature !== undefined) {
      if (reasoning) {
        if (!this.warnedTemperature) {
          this.warnedTemperature = true;
          this.logger.warn(
            `@wappa/openai: model ${this.model} does not support temperature; ignoring`
          );
        }
      } else {
        params.temperature = req.temperature;
      }
    }
    if (reasoning) params.reasoning_effort = this.reasoningEffort ?? 'low';
    const resp = await this.client.chat.completions.create(params);
    const result = fromOpenAIResponse(resp, this.logger);
    if (result.finishReason === 'length' && result.text === null) {
      this.logger.warn(
        '@wappa/openai: completion budget exhausted before any output ' +
          "(finishReason 'length' with empty content); consider raising maxTokens",
        { model: this.model }
      );
    }
    return result;
  }
}
