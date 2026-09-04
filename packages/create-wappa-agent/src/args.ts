/**
 * Command-line argument parsing for create-wappa-agent. Zero dependencies —
 * built on node:util's parseArgs.
 */
import { parseArgs } from 'node:util';

/** Valid `--transport` values. */
export const TRANSPORTS = ['baileys', 'cloud-api', 'twilio'] as const;
/** Valid `--provider` values. */
export const PROVIDERS = ['anthropic', 'openai'] as const;

/** A WhatsApp transport choice. */
export type TransportChoice = (typeof TRANSPORTS)[number];
/** An LLM provider choice. */
export type ProviderChoice = (typeof PROVIDERS)[number];

/** Parsed CLI arguments. Fields are absent when not given on the command line. */
export interface CliArgs {
  /** Positional target directory, if given. */
  targetDir?: string;
  transport?: TransportChoice;
  provider?: ProviderChoice;
  /** `--yes`/`-y`: skip prompts, defaulting anything omitted. */
  yes: boolean;
  /** `--help`/`-h`. */
  help: boolean;
}

/** Invalid command-line input — the CLI prints the message plus usage and exits 1. */
export class UsageError extends Error {}

/** Assert `value` is one of `valid`, or throw a {@link UsageError} naming the flag. */
function checkChoice<T extends string>(
  flag: string,
  value: string,
  valid: readonly T[]
): T {
  if ((valid as readonly string[]).includes(value)) return value as T;
  throw new UsageError(
    `Invalid --${flag} ${JSON.stringify(value)} — expected one of: ${valid.join(', ')}`
  );
}

/**
 * Parse `argv` (without the leading `node script` entries) into {@link CliArgs}.
 * Throws {@link UsageError} on unknown flags, missing option values, extra
 * positionals, or invalid --transport/--provider values.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  let values: { transport?: string; provider?: string; yes?: boolean; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        transport: { type: 'string' },
        provider: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (positionals.length > 1) {
    throw new UsageError(
      `Unexpected extra arguments: ${positionals.slice(1).join(' ')} (only one target directory is allowed)`
    );
  }

  const args: CliArgs = { yes: values.yes ?? false, help: values.help ?? false };
  if (positionals[0] !== undefined) args.targetDir = positionals[0];
  if (values.transport !== undefined) {
    args.transport = checkChoice('transport', values.transport, TRANSPORTS);
  }
  if (values.provider !== undefined) {
    args.provider = checkChoice('provider', values.provider, PROVIDERS);
  }
  return args;
}
