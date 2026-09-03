/**
 * Project generation: loads plain-text templates from the package's
 * `templates/` directory, substitutes `__PLACEHOLDER__` variables, and writes
 * the new project. All 4 transport×provider combos are composed from ONE
 * parameterized src/index.ts template plus per-choice partial snippets.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderChoice, TransportChoice } from './args.js';

/** A scaffolding failure the CLI reports to the user (message + exit 1). */
export class ScaffoldError extends Error {}

/** Absolute path of the shipped templates directory (works from src/ and dist/). */
const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url));

/** Absolute path of this package's own package.json (version source of truth). */
const OWN_PACKAGE_JSON = fileURLToPath(new URL('../package.json', import.meta.url));

/** Per-choice metadata: npm dependency, README label, and partial template file. */
interface ChoiceMeta {
  dep: string;
  label: string;
  partial: string;
}

const TRANSPORT_META: Record<TransportChoice, ChoiceMeta> = {
  baileys: {
    dep: '@wappa/baileys',
    label: 'Baileys (personal number, QR login)',
    partial: 'transport-baileys.tmpl',
  },
  'cloud-api': {
    dep: '@wappa/cloud-api',
    label: 'WhatsApp Cloud API (official)',
    partial: 'transport-cloud-api.tmpl',
  },
};

const PROVIDER_META: Record<ProviderChoice, ChoiceMeta> = {
  anthropic: {
    dep: '@wappa/anthropic',
    label: 'Anthropic (Claude)',
    partial: 'provider-anthropic.tmpl',
  },
  openai: {
    dep: '@wappa/openai',
    label: 'OpenAI',
    partial: 'provider-openai.tmpl',
  },
};

/** Options for {@link scaffoldProject}. */
export interface ScaffoldOptions {
  /** Target directory (relative paths resolve against cwd). Must be empty or absent. */
  targetDir: string;
  transport: TransportChoice;
  provider: ProviderChoice;
  /** npm package name for the generated project. Default: sanitized dir basename. */
  projectName?: string;
}

/** What {@link scaffoldProject} created. */
export interface ScaffoldResult {
  /** Absolute path of the generated project. */
  dir: string;
  /** npm package name written into the generated package.json. */
  projectName: string;
  /** Project-relative paths of every file written, in write order. */
  files: string[];
}

/**
 * Substitute every `__NAME__` placeholder in `text` from `vars`. Throws
 * {@link ScaffoldError} on a placeholder with no variable — template drift
 * must fail loudly, never ship literally.
 */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/__([A-Z][A-Z0-9_]*)__/g, (token, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new ScaffoldError(`Unresolved template placeholder ${token}`);
    }
    return value;
  });
}

/**
 * Split a partial template into its named sections. A line of the exact form
 * `<<<name>>>` starts section `name`; its content runs to the next marker,
 * with the trailing newline trimmed.
 */
export function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    if (current !== undefined) sections[current] = buf.join('\n').replace(/\n$/, '');
  };
  for (const line of text.split('\n')) {
    const marker = /^<<<([a-z][a-z0-9-]*)>>>\s*$/.exec(line);
    if (marker) {
      flush();
      current = marker[1];
      buf = [];
    } else if (current !== undefined) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Derive a valid npm package name from a directory name: lowercased, invalid
 * characters collapsed to `-`, leading/trailing separators stripped. Falls
 * back to `wappa-agent` when nothing usable remains.
 */
export function toPackageName(dirName: string): string {
  const name = dirName
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '');
  return name || 'wappa-agent';
}

/** Read a template file from `templates/` (or a partial from `templates/partials/`). */
async function loadTemplate(...segments: string[]): Promise<string> {
  return readFile(path.join(TEMPLATES_DIR, ...segments), 'utf8');
}

/** Load a partial template and validate that it carries every required section. */
async function loadPartial(file: string): Promise<Record<string, string>> {
  const sections = parseSections(await loadTemplate('partials', file));
  for (const required of ['import', 'setup', 'env', 'readme']) {
    if (sections[required] === undefined) {
      throw new ScaffoldError(`Template partial ${file} is missing section <<<${required}>>>`);
    }
  }
  return sections;
}

/**
 * Throw {@link ScaffoldError} unless `dir` is missing or an empty directory —
 * scaffolding never touches existing files.
 */
async function ensureEmptyDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new ScaffoldError(`Cannot scaffold into ${dir}: ${(err as Error).message}`);
  }
  if (entries.length > 0) {
    throw new ScaffoldError(`Directory ${dir} is not empty — refusing to scaffold into it.`);
  }
}

/** This CLI's own version, so generated wappa deps pin to the matching release. */
async function ownVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(OWN_PACKAGE_JSON, 'utf8')) as { version: string };
  return pkg.version;
}

/**
 * Generate a complete wappa agent project for the chosen transport/provider
 * combo: package.json, tsconfig.json, src/index.ts, .env.example, .gitignore,
 * and README.md. Refuses non-empty target directories; never runs npm install.
 */
export async function scaffoldProject(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const dir = path.resolve(opts.targetDir);
  await ensureEmptyDir(dir);

  const transport = TRANSPORT_META[opts.transport];
  const provider = PROVIDER_META[opts.provider];
  const [transportParts, providerParts, version] = await Promise.all([
    loadPartial(transport.partial),
    loadPartial(provider.partial),
    ownVersion(),
  ]);

  const vars: Record<string, string> = {
    PROJECT_NAME: opts.projectName ?? toPackageName(path.basename(dir)),
    FRAM_VERSION: `^${version}`,
    TRANSPORT_DEP: transport.dep,
    TRANSPORT_LABEL: transport.label,
    TRANSPORT_IMPORT: transportParts['import']!,
    TRANSPORT_SETUP: transportParts['setup']!,
    TRANSPORT_ENV: transportParts['env']!,
    TRANSPORT_README: transportParts['readme']!,
    PROVIDER_DEP: provider.dep,
    PROVIDER_LABEL: provider.label,
    PROVIDER_IMPORT: providerParts['import']!,
    PROVIDER_SETUP: providerParts['setup']!,
    PROVIDER_ENV: providerParts['env']!,
    PROVIDER_README: providerParts['readme']!,
  };

  /** template file in templates/ → project-relative output path */
  const outputs: Array<[template: string, target: string]> = [
    ['package.json.tmpl', 'package.json'],
    ['tsconfig.json.tmpl', 'tsconfig.json'],
    ['index.ts.tmpl', path.join('src', 'index.ts')],
    ['env.example.tmpl', '.env.example'],
    ['gitignore.tmpl', '.gitignore'],
    ['README.md.tmpl', 'README.md'],
  ];

  await mkdir(path.join(dir, 'src'), { recursive: true });
  const files: string[] = [];
  for (const [template, target] of outputs) {
    const rendered = renderTemplate(await loadTemplate(template), vars);
    await writeFile(path.join(dir, target), rendered, 'utf8');
    files.push(target);
  }

  return { dir, projectName: vars['PROJECT_NAME']!, files };
}
