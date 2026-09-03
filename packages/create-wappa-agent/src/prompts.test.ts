import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { CliArgs } from './args.js';
import { DEFAULT_DIR, DEFAULT_PROVIDER, DEFAULT_TRANSPORT, resolveChoices } from './prompts.js';

/** Scripted stdin/stdout pair; `answers` are fed line by line, then EOF. */
function streams(answers: string[] = []) {
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = '';
  output.on('data', (chunk: Buffer) => {
    transcript += chunk.toString();
  });
  input.end(answers.map((a) => `${a}\n`).join(''));
  return { input, output, transcript: () => transcript };
}

const base: CliArgs = { yes: false, help: false };

describe('resolveChoices', () => {
  it('--yes applies defaults without prompting', async () => {
    const io = streams();
    const choices = await resolveChoices({ ...base, yes: true }, io);
    expect(choices).toEqual({
      targetDir: DEFAULT_DIR,
      transport: DEFAULT_TRANSPORT,
      provider: DEFAULT_PROVIDER,
    });
    expect(io.transcript()).toBe('');
  });

  it('does not prompt when every value came from flags', async () => {
    const io = streams();
    const choices = await resolveChoices(
      { ...base, targetDir: 'd', transport: 'cloud-api', provider: 'openai' },
      io
    );
    expect(choices).toEqual({ targetDir: 'd', transport: 'cloud-api', provider: 'openai' });
    expect(io.transcript()).toBe('');
  });

  it('prompts for everything missing, accepting menu numbers', async () => {
    const io = streams(['my-project', '2', '2']);
    const choices = await resolveChoices(base, io);
    expect(choices).toEqual({
      targetDir: 'my-project',
      transport: 'cloud-api',
      provider: 'openai',
    });
    expect(io.transcript()).toContain('Project directory');
    expect(io.transcript()).toContain('baileys');
    expect(io.transcript()).toContain('anthropic');
  });

  it('accepts choice names case-insensitively and defaults on empty input', async () => {
    const io = streams(['', 'BAILEYS', 'openai']);
    const choices = await resolveChoices(base, io);
    expect(choices).toEqual({
      targetDir: DEFAULT_DIR,
      transport: 'baileys',
      provider: 'openai',
    });
  });

  it('re-asks after an invalid menu answer', async () => {
    const io = streams(['dir', '9', 'nope', 'cloud-api', '1']);
    const choices = await resolveChoices(base, io);
    expect(choices).toEqual({ targetDir: 'dir', transport: 'cloud-api', provider: 'anthropic' });
    expect(io.transcript()).toContain('Please answer 1-2');
  });

  it('only prompts for the values flags left open', async () => {
    const io = streams(['', '2']);
    const choices = await resolveChoices({ ...base, transport: 'baileys' }, io);
    expect(choices).toEqual({
      targetDir: DEFAULT_DIR,
      transport: 'baileys',
      provider: 'openai',
    });
    expect(io.transcript()).not.toContain('Choose transport');
  });

  it('falls back to defaults when input ends early', async () => {
    const io = streams(['early-dir']);
    const choices = await resolveChoices(base, io);
    expect(choices).toEqual({
      targetDir: 'early-dir',
      transport: DEFAULT_TRANSPORT,
      provider: DEFAULT_PROVIDER,
    });
  });
});
