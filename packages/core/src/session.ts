import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage } from './provider.js';

/** Per-chat durable state: conversation history plus arbitrary user data. */
export interface SessionData {
  history: ChatMessage[];
  /** Arbitrary user data persisted across messages (named `data`, not `state`, to avoid confusion with the ephemeral ctx.state). */
  data: Record<string, unknown>;
  /** Human-handoff flag: when true, router + agent are skipped. */
  paused?: boolean;
  updatedAt: number;
}

/** Fresh, empty session: `{ history: [], data: {}, updatedAt: 0 }`. */
export function createSession(): SessionData {
  return { history: [], data: {}, updatedAt: 0 };
}

/** Pluggable session persistence, keyed by chat id. */
export interface SessionStore {
  get(chatId: string): Promise<SessionData | undefined>;
  set(chatId: string, data: SessionData): Promise<void>;
  delete(chatId: string): Promise<void>;
}

/** In-memory, Map-backed session store (the Bot default). Not durable. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  async get(chatId: string): Promise<SessionData | undefined> {
    return this.sessions.get(chatId);
  }

  async set(chatId: string, data: SessionData): Promise<void> {
    this.sessions.set(chatId, data);
  }

  async delete(chatId: string): Promise<void> {
    this.sessions.delete(chatId);
  }
}

/**
 * One JSON file per chat under dir; chatId sanitized for filenames (encodeURIComponent).
 * Atomic-ish write (tmp+rename); dir created 0o700, files written 0o600. get() returns
 * undefined for a missing file (ENOENT), unparseable JSON, and JSON that is not a
 * session shape (a corrupt file must never permanently brick a chat — the next set()
 * overwrites it). Every other read error (EACCES, EMFILE, EIO, …) is RETHROWN: treating
 * a transient failure as "no session" would let the end-of-turn save destroy the real
 * history and paused flag.
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private fileFor(chatId: string): string {
    return join(this.dir, `${encodeURIComponent(chatId)}.json`);
  }

  async get(chatId: string): Promise<SessionData | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(chatId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw err; // transient errors must not read as "no session"
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined; // corrupt JSON self-heals on the next set()
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as SessionData).history) ||
      typeof (parsed as SessionData).data !== 'object' ||
      (parsed as SessionData).data === null
    ) {
      return undefined; // wrong shape self-heals like corrupt JSON
    }
    return parsed as SessionData;
  }

  async set(chatId: string, data: SessionData): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileFor(chatId);
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, file);
  }

  async delete(chatId: string): Promise<void> {
    await rm(this.fileFor(chatId), { force: true });
  }
}
