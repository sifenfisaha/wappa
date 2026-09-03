import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, FileSessionStore, MemorySessionStore } from './session.js';

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wappa-core-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('createSession', () => {
  it('returns the exact empty shape', () => {
    expect(createSession()).toEqual({ history: [], data: {}, updatedAt: 0 });
  });

  it('returns a fresh object each call', () => {
    const a = createSession();
    const b = createSession();
    expect(a).not.toBe(b);
    expect(a.history).not.toBe(b.history);
  });
});

describe('MemorySessionStore', () => {
  it('round-trips sessions', async () => {
    const store = new MemorySessionStore();
    const session = createSession();
    session.data['x'] = 1;
    await store.set('chat-1', session);
    await expect(store.get('chat-1')).resolves.toBe(session);
  });

  it('returns undefined for unknown chats', async () => {
    await expect(new MemorySessionStore().get('nope')).resolves.toBeUndefined();
  });

  it('deletes sessions', async () => {
    const store = new MemorySessionStore();
    await store.set('chat-1', createSession());
    await store.delete('chat-1');
    await expect(store.get('chat-1')).resolves.toBeUndefined();
  });
});

describe('FileSessionStore', () => {
  it('round-trips sessions through JSON files', async () => {
    const store = new FileSessionStore(await makeTmpDir());
    const session = createSession();
    session.history.push({ role: 'user', content: 'hi' });
    session.data['name'] = 'Ana';
    session.paused = true;
    session.updatedAt = 123;
    await store.set('chat-1', session);
    const loaded = await store.get('chat-1');
    expect(loaded).toEqual(session);
    expect(loaded).not.toBe(session); // file store returns copies
  });

  it('returns undefined for a missing file', async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('returns undefined for corrupt JSON, and the next set() recovers the chat', async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    await writeFile(join(dir, `${encodeURIComponent('chat-1')}.json`), '{not json!', 'utf8');
    await expect(store.get('chat-1')).resolves.toBeUndefined();

    const fresh = createSession();
    fresh.updatedAt = 5;
    await store.set('chat-1', fresh);
    await expect(store.get('chat-1')).resolves.toEqual(fresh);
  });

  it('rethrows non-ENOENT read errors instead of treating them as a missing session', async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    // A directory where the session file should be → readFile fails with EISDIR, which
    // must propagate (a transient EMFILE/EACCES/EIO read as "no session" would let the
    // end-of-turn save destroy the real history and paused flag).
    await mkdir(join(dir, `${encodeURIComponent('chat-1')}.json`));
    await expect(store.get('chat-1')).rejects.toThrow();
  });

  it('returns undefined for JSON that is not a valid session shape', async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    const file = join(dir, `${encodeURIComponent('chat-1')}.json`);

    await writeFile(file, '{"history":5}', 'utf8'); // history not an array
    await expect(store.get('chat-1')).resolves.toBeUndefined();

    await writeFile(file, '"just a string"', 'utf8'); // not an object
    await expect(store.get('chat-1')).resolves.toBeUndefined();

    await writeFile(file, '{"history":[],"data":null,"updatedAt":0}', 'utf8'); // data null
    await expect(store.get('chat-1')).resolves.toBeUndefined();

    // A mismatched shape self-heals like corrupt JSON: the next set() recovers the chat.
    const fresh = createSession();
    await store.set('chat-1', fresh);
    await expect(store.get('chat-1')).resolves.toEqual(fresh);
  });

  it.skipIf(process.platform === 'win32')(
    'creates the directory 0o700 and session files 0o600',
    async () => {
      const dir = join(await makeTmpDir(), 'sessions');
      const store = new FileSessionStore(dir);
      await store.set('chat-1', createSession());
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(dir, 'chat-1.json'))).mode & 0o777).toBe(0o600);
    }
  );

  it('sanitizes chat ids for filenames (JIDs, path traversal)', async () => {
    const dir = await makeTmpDir();
    const store = new FileSessionStore(dir);
    const ids = ['123456789@s.whatsapp.net', '../../evil', 'a/b\\c'];
    for (const [i, id] of ids.entries()) {
      const session = createSession();
      session.updatedAt = i + 1;
      await store.set(id, session);
    }
    for (const [i, id] of ids.entries()) {
      const loaded = await store.get(id);
      expect(loaded?.updatedAt).toBe(i + 1);
    }
    // Every file landed inside dir (no traversal), one per chat, no stray tmp files.
    const files = await readdir(dir);
    expect(files).toHaveLength(ids.length);
    expect(files.every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('deletes sessions and tolerates deleting a missing one', async () => {
    const store = new FileSessionStore(await makeTmpDir());
    await store.set('chat-1', createSession());
    await store.delete('chat-1');
    await expect(store.get('chat-1')).resolves.toBeUndefined();
    await expect(store.delete('chat-1')).resolves.toBeUndefined();
  });

  it('creates the directory lazily on first set()', async () => {
    const dir = join(await makeTmpDir(), 'nested', 'sessions');
    const store = new FileSessionStore(dir);
    await expect(store.get('x')).resolves.toBeUndefined();
    await store.set('x', createSession());
    await expect(store.get('x')).resolves.toEqual(createSession());
  });
});
