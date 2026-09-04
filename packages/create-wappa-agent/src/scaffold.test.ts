import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScaffoldError,
  parseSections,
  renderTemplate,
  scaffoldProject,
  toPackageName,
} from './scaffold.js';

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));

let sandbox: string;

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'create-wappa-agent-unit-'));
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('renderTemplate', () => {
  it('substitutes every occurrence of a placeholder', () => {
    expect(renderTemplate('__A__ and __B__ and __A__', { A: 'x', B: 'y' })).toBe(
      'x and y and x'
    );
  });

  it('throws on an unresolved placeholder instead of shipping it literally', () => {
    expect(() => renderTemplate('hello __NOPE__', {})).toThrowError(ScaffoldError);
    expect(() => renderTemplate('hello __NOPE__', {})).toThrowError(/__NOPE__/);
  });

  it('leaves lowercase dunder identifiers alone', () => {
    expect(renderTemplate('__proto__', {})).toBe('__proto__');
  });
});

describe('parseSections', () => {
  it('splits marker-delimited sections and trims the trailing newline', () => {
    const text = '<<<import>>>\nimport x;\n<<<setup>>>\nline1\nline2\n';
    expect(parseSections(text)).toEqual({ import: 'import x;', setup: 'line1\nline2' });
  });

  it('ignores content before the first marker', () => {
    expect(parseSections('junk\n<<<env>>>\nA=1\n')).toEqual({ env: 'A=1' });
  });
});

describe('toPackageName', () => {
  it('lowercases and collapses invalid characters', () => {
    expect(toPackageName('My Bot!')).toBe('my-bot');
    expect(toPackageName('Support_Agent (v2)')).toBe('support_agent-v2');
  });

  it('strips leading/trailing separators', () => {
    expect(toPackageName('.hidden-bot.')).toBe('hidden-bot');
  });

  it('falls back to wappa-agent when nothing usable remains', () => {
    expect(toPackageName('...')).toBe('wappa-agent');
    expect(toPackageName('')).toBe('wappa-agent');
  });
});

describe('scaffoldProject', () => {
  const combos = [
    ['baileys', 'anthropic'],
    ['baileys', 'openai'],
    ['cloud-api', 'anthropic'],
    ['cloud-api', 'openai'],
    ['twilio', 'anthropic'],
    ['twilio', 'openai'],
  ] as const;

  const TRANSPORT_CLASS = {
    baileys: 'BaileysTransport',
    'cloud-api': 'CloudApiTransport',
    twilio: 'TwilioTransport',
  } as const;
  const PROVIDER_CLASS = {
    anthropic: 'AnthropicProvider',
    openai: 'OpenAIProvider',
  } as const;

  it.each(combos)('generates a complete %s + %s project', async (transport, provider) => {
    const dir = path.join(sandbox, `combo-${transport}-${provider}`);
    const result = await scaffoldProject({ targetDir: dir, transport, provider });

    expect(result.dir).toBe(dir);
    expect(result.projectName).toBe(`combo-${transport}-${provider}`);
    expect(result.files.sort()).toEqual(
      ['.env.example', '.gitignore', 'README.md', 'package.json', 'tsconfig.json', path.join('src', 'index.ts')].sort()
    );

    const ownVersion = (
      JSON.parse(await readFile(path.join(PKG_DIR, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      name: string;
      type: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies).toEqual({
      '@wappa/core': `^${ownVersion}`,
      [`@wappa/${transport}`]: `^${ownVersion}`,
      [`@wappa/${provider}`]: `^${ownVersion}`,
    });
    expect(pkg.scripts['build']).toBe('tsc');
    expect(pkg.scripts['start']).toBe('node --env-file=.env dist/index.js');

    const index = await readFile(path.join(dir, 'src', 'index.ts'), 'utf8');
    expect(index).toContain(TRANSPORT_CLASS[transport]);
    expect(index).toContain(PROVIDER_CLASS[provider]);
    for (const other of Object.values(TRANSPORT_CLASS)) {
      if (other !== TRANSPORT_CLASS[transport]) expect(index).not.toContain(other);
    }
    for (const other of Object.values(PROVIDER_CLASS)) {
      if (other !== PROVIDER_CLASS[provider]) expect(index).not.toContain(other);
    }
    expect(index).not.toMatch(/__[A-Z][A-Z0-9_]*__/);

    const env = await readFile(path.join(dir, '.env.example'), 'utf8');
    if (provider === 'anthropic') expect(env).toContain('ANTHROPIC_API_KEY=');
    else expect(env).toContain('OPENAI_API_KEY=');
    if (transport === 'cloud-api') {
      expect(env).toContain('WHATSAPP_ACCESS_TOKEN=');
      expect(env).toContain('WHATSAPP_PHONE_NUMBER_ID=');
      expect(env).toContain('WHATSAPP_VERIFY_TOKEN=');
    }
    if (transport === 'twilio') {
      expect(env).toContain('TWILIO_ACCOUNT_SID=');
      expect(env).toContain('TWILIO_AUTH_TOKEN=');
      expect(env).toContain('TWILIO_WHATSAPP_NUMBER=');
      expect(env).toContain('PORT=');
    }

    const readme = await readFile(path.join(dir, 'README.md'), 'utf8');
    if (transport === 'baileys') {
      expect(readme).toMatch(/Terms of Service/);
      expect(readme).toMatch(/unofficial/i);
    } else if (transport === 'twilio') {
      expect(readme).toMatch(/webhook/i);
      expect(readme).toMatch(/sandbox/i);
      expect(readme).toMatch(/join/i);
      expect(readme).toMatch(/ngrok/i);
    } else {
      expect(readme).toMatch(/webhook/i);
      expect(readme).toMatch(/verify token/i);
    }

    const gitignore = await readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('.env');
  });

  it('refuses a non-empty directory and writes nothing', async () => {
    const dir = path.join(sandbox, 'occupied');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'keep.txt'), 'precious', 'utf8');

    await expect(
      scaffoldProject({ targetDir: dir, transport: 'baileys', provider: 'anthropic' })
    ).rejects.toThrowError(/not empty/);
    expect((await readdir(dir)).sort()).toEqual(['keep.txt']);
  });

  it('scaffolds into an existing EMPTY directory', async () => {
    const dir = path.join(sandbox, 'empty-existing');
    await mkdir(dir, { recursive: true });
    const result = await scaffoldProject({
      targetDir: dir,
      transport: 'cloud-api',
      provider: 'openai',
    });
    expect(result.files).toContain('package.json');
  });

  it('refuses when the target path is a file', async () => {
    const file = path.join(sandbox, 'a-file');
    await writeFile(file, 'x', 'utf8');
    await expect(
      scaffoldProject({ targetDir: file, transport: 'baileys', provider: 'openai' })
    ).rejects.toThrowError(ScaffoldError);
  });

  it('honors an explicit projectName over the directory basename', async () => {
    const dir = path.join(sandbox, 'named');
    const result = await scaffoldProject({
      targetDir: dir,
      transport: 'baileys',
      provider: 'anthropic',
      projectName: 'custom-name',
    });
    expect(result.projectName).toBe('custom-name');
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      name: string;
    };
    expect(pkg.name).toBe('custom-name');
  });
});
