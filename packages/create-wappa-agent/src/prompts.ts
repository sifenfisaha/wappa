/**
 * Interactive prompts (node:readline/promises) filling in whatever the CLI
 * flags left unspecified. `--yes` skips all prompting and applies defaults.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { PROVIDERS, TRANSPORTS } from './args.js';
import type { CliArgs, ProviderChoice, TransportChoice } from './args.js';

/** Default target directory when none is given. */
export const DEFAULT_DIR = 'my-wappa-agent';
/** Default transport when none is given. */
export const DEFAULT_TRANSPORT: TransportChoice = 'baileys';
/** Default provider when none is given. */
export const DEFAULT_PROVIDER: ProviderChoice = 'anthropic';

/** One-line description per transport, shown in the menu. */
const TRANSPORT_HELP: Record<TransportChoice, string> = {
  baileys: 'personal number, QR login (unofficial — ToS risk)',
  'cloud-api': 'official WhatsApp Cloud API (Meta webhook)',
};

/** One-line description per provider, shown in the menu. */
const PROVIDER_HELP: Record<ProviderChoice, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI (or any OpenAI-compatible server)',
};

/** Fully resolved scaffolding choices — every field decided. */
export interface ResolvedChoices {
  targetDir: string;
  transport: TransportChoice;
  provider: ProviderChoice;
}

/** Injectable streams so tests can script the interaction. */
export interface PromptStreams {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Question-asker over a readline Interface that never loses input: lines
 * arriving while no question is pending (piped stdin delivers everything at
 * once) are buffered and served to the next question. Stream end/closure
 * yields '' — every prompt then falls back to its default.
 */
class Asker {
  private readonly pending: string[] = [];
  private closed = false;

  constructor(
    private readonly rl: Interface,
    private readonly output: NodeJS.WritableStream
  ) {
    rl.on('line', (line: string) => {
      this.pending.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
    });
  }

  /** Ask one question and return the trimmed answer ('' on EOF). */
  async ask(question: string): Promise<string> {
    const buffered = this.pending.shift();
    if (buffered !== undefined) {
      this.output.write(question);
      return buffered.trim();
    }
    if (this.closed) return '';
    try {
      return (await this.rl.question(question)).trim();
    } catch {
      return '';
    }
  }
}

/**
 * Menu prompt: prints numbered choices and accepts a number or a choice name
 * (case-insensitive). Empty input picks `def`; invalid input re-asks (until
 * EOF, which also picks `def`).
 */
async function choose<T extends string>(
  asker: Asker,
  output: NodeJS.WritableStream,
  label: string,
  choices: readonly T[],
  help: Record<T, string>,
  def: T
): Promise<T> {
  output.write(`${label}:\n`);
  choices.forEach((choice, i) => {
    output.write(`  ${i + 1}. ${choice.padEnd(10)} ${help[choice]}\n`);
  });
  const defIndex = choices.indexOf(def) + 1;
  for (;;) {
    const answer = await asker.ask(
      `Choose ${label.toLowerCase()} [1-${choices.length}] (${defIndex}): `
    );
    if (answer === '') return def;
    if (/^\d+$/.test(answer)) {
      const byNumber = choices[Number(answer) - 1];
      if (byNumber !== undefined) return byNumber;
    }
    const byName = choices.find((c) => c.toLowerCase() === answer.toLowerCase());
    if (byName !== undefined) return byName;
    output.write(`Please answer 1-${choices.length} or one of: ${choices.join(', ')}\n`);
  }
}

/**
 * Resolve the target directory, transport, and provider: values given via
 * flags are kept; with `--yes` the rest defaults silently; otherwise each
 * missing value is prompted for interactively.
 */
export async function resolveChoices(
  args: CliArgs,
  streams: PromptStreams = {}
): Promise<ResolvedChoices> {
  const needsPrompt = !args.yes && (!args.targetDir || !args.transport || !args.provider);
  if (!needsPrompt) {
    return {
      targetDir: args.targetDir ?? DEFAULT_DIR,
      transport: args.transport ?? DEFAULT_TRANSPORT,
      provider: args.provider ?? DEFAULT_PROVIDER,
    };
  }

  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const rl = createInterface({ input, output });
  const asker = new Asker(rl, output);
  try {
    const targetDir =
      args.targetDir ??
      ((await asker.ask(`Project directory (${DEFAULT_DIR}): `)) || DEFAULT_DIR);
    const transport =
      args.transport ??
      (await choose(asker, output, 'Transport', TRANSPORTS, TRANSPORT_HELP, DEFAULT_TRANSPORT));
    const provider =
      args.provider ??
      (await choose(asker, output, 'Provider', PROVIDERS, PROVIDER_HELP, DEFAULT_PROVIDER));
    return { targetDir, transport, provider };
  } finally {
    rl.close();
  }
}
