import { describe, expect, it } from 'vitest';
import { UsageError, parseCliArgs } from './args.js';

describe('parseCliArgs', () => {
  it('parses positional dir and long flags', () => {
    expect(parseCliArgs(['my-bot', '--transport', 'cloud-api', '--provider', 'openai'])).toEqual({
      targetDir: 'my-bot',
      transport: 'cloud-api',
      provider: 'openai',
      yes: false,
      help: false,
    });
  });

  it('parses --flag=value form and --yes', () => {
    expect(parseCliArgs(['--transport=baileys', '--provider=anthropic', '--yes'])).toEqual({
      transport: 'baileys',
      provider: 'anthropic',
      yes: true,
      help: false,
    });
  });

  it('accepts -y and -h shorthands', () => {
    expect(parseCliArgs(['-y'])).toEqual({ yes: true, help: false });
    expect(parseCliArgs(['-h'])).toEqual({ yes: false, help: true });
  });

  it('leaves omitted values absent', () => {
    expect(parseCliArgs([])).toEqual({ yes: false, help: false });
  });

  it('accepts the twilio transport', () => {
    expect(parseCliArgs(['--transport', 'twilio']).transport).toBe('twilio');
  });

  it('rejects an invalid transport, naming the valid values', () => {
    expect(() => parseCliArgs(['--transport', 'telegram'])).toThrowError(UsageError);
    expect(() => parseCliArgs(['--transport', 'telegram'])).toThrowError(
      /baileys, cloud-api, twilio/
    );
  });

  it('rejects an invalid provider', () => {
    expect(() => parseCliArgs(['--provider', 'gemini'])).toThrowError(/anthropic, openai/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--frobnicate'])).toThrowError(UsageError);
  });

  it('rejects a flag with a missing value', () => {
    expect(() => parseCliArgs(['--transport'])).toThrowError(UsageError);
  });

  it('rejects extra positionals', () => {
    expect(() => parseCliArgs(['a', 'b'])).toThrowError(/only one target directory/);
  });
});
