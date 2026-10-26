// -----------------------------------------------------------------------------
// The state read back from /data: repaired, capped, never a token.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOUR } from '../src/constants.js';
import { fileStore, fingerprint, newSalt, normalizeMemory } from '../src/store.js';

test('normalizeMemory: repaired, pause capped, stop with its fingerprint, attempt capped', () => {
  const now = 1_000_000_000;
  const empty = normalizeMemory(null, now);
  assert.deepEqual(empty, {
    salt: null,
    pause: null,
    block: null,
    protect: {},
    lastAttemptAt: undefined,
  });
  const memory = normalizeMemory(
    {
      salt: 'a'.repeat(32),
      pause: { kind: 'rate', until: now + 10 * HOUR },
      block: { kind: 'refused', fingerprint: 'b'.repeat(16) },
      lastAttemptAt: now + HOUR,
      token: 'never read',
    },
    now,
  );
  assert.equal(memory.salt, 'a'.repeat(32));
  assert.deepEqual(memory.pause, { kind: 'rate', until: now + 6 * HOUR });
  assert.deepEqual(memory.block, { kind: 'refused', fingerprint: 'b'.repeat(16) });
  assert.equal(memory.lastAttemptAt, now, 'never in the future');
  assert.equal('token' in memory, false);
  assert.equal(normalizeMemory({ pause: { kind: 'rate', until: now - 1 } }, now).pause, null);
  assert.equal(normalizeMemory({ pause: { kind: 'backoff', until: now + 1 } }, now).pause, null);
  assert.equal(
    normalizeMemory({ block: { kind: 'other', fingerprint: 'b'.repeat(16) } }, now).block,
    null,
  );
  assert.equal(normalizeMemory({ salt: 'short' }, now).salt, null);
});

test('the fingerprint: salted, 16 hex digits, changes with any token', () => {
  const salt = newSalt();
  assert.match(salt, /^[0-9a-f]{32}$/);
  const a = fingerprint(salt, 'api', 'refresh');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, fingerprint(salt, 'api', 'other'));
  assert.notEqual(a, fingerprint(salt, 'other', 'refresh'));
  assert.notEqual(a, fingerprint(newSalt(), 'api', 'refresh'));
});

test('the file store: atomic, 0600, bounded, one write after the other', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'lightwave-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.equal(await store.load(), null);
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(await store.load(), { a: 2 });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).a, 2);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }
  await store.save({ big: 'x'.repeat(70_000) });
  assert.equal(await store.load(), null, 'a file too large is not ours');
});
