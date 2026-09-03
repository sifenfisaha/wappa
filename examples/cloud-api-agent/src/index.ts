/**
 * cloud-api-agent — OpenAI + the official WhatsApp Cloud API, deployed as a
 * webhook server.
 *
 * What it shows:
 *   - CloudApiTransport running its own HTTP server (`port`) so Meta's webhook
 *     can deliver messages — no Express or SDK required
 *   - OpenAIProvider (or any OpenAI-compatible server via OPENAI_BASE_URL)
 *   - a single demo tool, get_weather
 *
 * Env (see .env.example): WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
 * WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, OPENAI_API_KEY, PORT.
 */
import { Agent, Bot, consoleLogger, defineTool } from '@wappa/core';
import { CloudApiTransport } from '@wappa/cloud-api';
import { OpenAIProvider } from '@wappa/openai';
import { z } from 'zod';

const logger = consoleLogger();

/** Read a required env var, failing fast with a pointer to .env.example. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — see .env.example`);
  return value;
}

const getWeather = defineTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: z.object({ city: z.string().describe('City name, e.g. "Lisbon"') }),
  // A deterministic stub so the example runs without any weather API key —
  // swap the body for a real fetch() when you wire up a provider.
  execute: ({ city }) => {
    const conditions = ['sunny', 'cloudy', 'rainy', 'windy'] as const;
    const seed = [...city.toLowerCase()].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
    return {
      city,
      condition: conditions[seed % conditions.length],
      temperatureC: 8 + (seed % 25),
    };
  },
});

const transport = new CloudApiTransport({
  accessToken: requireEnv('WHATSAPP_ACCESS_TOKEN'),
  phoneNumberId: requireEnv('WHATSAPP_PHONE_NUMBER_ID'),
  // Meta echoes this token back during webhook verification (the GET
  // hub.challenge handshake) — invent any string and configure the same value
  // in the app dashboard.
  verifyToken: requireEnv('WHATSAPP_VERIFY_TOKEN'),
  // With the app secret set, every POST is authenticated via its
  // X-Hub-Signature-256 header; without it, anyone who finds your URL can
  // inject messages — the transport logs a warning if you leave it off.
  appSecret: process.env.WHATSAPP_APP_SECRET,
  // `port` makes the transport start its own node:http server and answer
  // GET (verification) + POST (events) on /webhook. To mount into an existing
  // server instead, omit `port` and call transport.handleRequest(req, res).
  port: Number(process.env.PORT ?? 3000),
  logger,
});

const agent = new Agent({
  instructions:
    'You are a helpful weather assistant on WhatsApp. Keep answers to a couple of ' +
    'sentences. Use get_weather for any weather question; never invent conditions.',
  // OPENAI_API_KEY is picked up from the environment by default. Point this at
  // Ollama or any OpenAI-compatible server with { baseURL, model } instead.
  provider: new OpenAIProvider(),
  tools: [getWeather],
});

const bot = new Bot({ transport, agent, logger });

bot.on('ready', (info) =>
  logger.info(`cloud-api-agent ready`, {
    phoneNumberId: info.selfId,
    webhook: `http://localhost:${process.env.PORT ?? 3000}/webhook`,
  })
);

// stop() finishes in-flight turns (and their session saves) before closing the
// HTTP server, so a deploy rollover never drops a half-answered message.
process.once('SIGINT', () => void bot.stop().then(() => process.exit(0)));
process.once('SIGTERM', () => void bot.stop().then(() => process.exit(0)));

await bot.start();
