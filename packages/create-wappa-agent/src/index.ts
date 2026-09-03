#!/usr/bin/env node
/**
 * create-wappa-agent — scaffold a new wappa WhatsApp agent project.
 *
 * Run via `npm create wappa-agent my-bot`. Zero runtime dependencies: argument
 * parsing with node:util, prompts with node:readline/promises, templates as
 * plain text files with __PLACEHOLDER__ substitution.
 */
import path from 'node:path';
import { PROVIDERS, TRANSPORTS, UsageError, parseCliArgs } from './args.js';
import { DEFAULT_DIR, DEFAULT_PROVIDER, DEFAULT_TRANSPORT, resolveChoices } from './prompts.js';
import { ScaffoldError, scaffoldProject } from './scaffold.js';
import type { ScaffoldResult } from './scaffold.js';
import type { ResolvedChoices } from './prompts.js';

const USAGE = `Usage: npm create wappa-agent [dir] -- [options]
   or: create-wappa-agent [dir] [options]

Scaffolds a WhatsApp agent project built on wappa. Missing values are prompted
for interactively (or defaulted with --yes). Refuses non-empty directories.

Options:
  --transport <${TRANSPORTS.join('|')}>  WhatsApp transport (default: ${DEFAULT_TRANSPORT})
  --provider <${PROVIDERS.join('|')}>    LLM provider (default: ${DEFAULT_PROVIDER})
  -y, --yes                          Skip prompts; use defaults for anything omitted
  -h, --help                         Show this help

Defaults: dir ${DEFAULT_DIR}, transport ${DEFAULT_TRANSPORT}, provider ${DEFAULT_PROVIDER}.
`;

/** Write a line to stdout. */
function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** Write a line to stderr. */
function printError(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** The post-scaffold "next steps" block (npm install is left to the user). */
function nextSteps(result: ScaffoldResult, choices: ResolvedChoices): string {
  const cdTarget = path.relative(process.cwd(), result.dir) || '.';
  const lines = [
    `Created ${result.projectName} (${choices.transport} + ${choices.provider}) at ${result.dir}`,
    '',
    'Next steps:',
    `  cd ${cdTarget}`,
    '  npm install',
    '  cp .env.example .env    # then fill in your keys',
    '  npm run build',
    '  npm start',
    '',
  ];
  if (choices.transport === 'baileys') {
    lines.push(
      'A QR code is printed on first start — scan it with WhatsApp on your phone.',
      'Note: Baileys is an unofficial client (ToS risk) — see README.md.'
    );
  } else {
    lines.push('Then point your Meta webhook at the server — README.md walks through it.');
  }
  return lines.join('\n');
}

/** CLI entry point. Returns the process exit code. */
async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      printError(err.message);
      printError('');
      printError(USAGE);
      return 1;
    }
    throw err;
  }

  if (args.help) {
    print(USAGE);
    return 0;
  }

  const choices = await resolveChoices(args);
  try {
    const result = await scaffoldProject(choices);
    print();
    print(nextSteps(result, choices));
    return 0;
  } catch (err) {
    if (err instanceof ScaffoldError) {
      printError(err.message);
      return 1;
    }
    throw err;
  }
}

process.exitCode = await main(process.argv.slice(2));
