/**
 * @wappa/openai — OpenAI (and OpenAI-compatible) LLM provider for wappa.
 *
 * Uses the Chat Completions API so it works against the real OpenAI API and
 * against compatible local servers (Ollama, vLLM, llama.cpp, ...) via `baseURL`.
 */
export { OpenAIProvider } from './provider.js';
export type { OpenAIProviderOptions, OpenAIChatClient } from './provider.js';
export { toOpenAIMessages, toOpenAITools, fromOpenAIResponse } from './mapping.js';
