// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), never a token (the tokens live in the Gladys configuration):
//   - a random salt made once (for the fingerprint below);
//   - the end of a 429 or 403 pause (wall clock, kept across restarts and
//     account changes);
//   - a stop on refused tokens, tied to a salted fingerprint of the API token
//     and the refresh token, so a restart does not retry what Lightwave
//     refused, and new tokens do;
//   - the time of the last read attempt, so a restart never reads sooner
//     than the interval.
// Every time read back is capped from now. The file is readable by the
// container user only (0600). Taken from gladys-leviton (approved).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/lightwave-state.json';
/** A larger file is not ours: ignored (read bounded). */
const MAX_STATE_BYTES = 64 * 1024;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        if ((await stat(path)).size > MAX_STATE_BYTES) {
          return null;
        }
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        // Written whole, flushed to disk, then renamed over the old file: a
        // power cut leaves the old file or the new one, never half of one.
        const temporary = `${path}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try {
          await file.writeFile(text, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        try {
          const dir = await open(dirname(path), 'r');
          try {
            await dir.sync();
          } finally {
            await dir.close();
          }
        } catch {
          // Not every system syncs a directory: the rename stands.
        }
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** The same in memory (tests). */
export function memoryStore(initial = null) {
  return {
    data: initial,
    saves: 0,
    async load() {
      return this.data === null ? null : structuredClone(this.data);
    },
    async save(data) {
      this.saves += 1;
      this.data = structuredClone(data);
    },
  };
}

export const newSalt = () => randomBytes(16).toString('hex');

/** The salted fingerprint of the tokens a stop belongs to (16 hex digits). */
export const fingerprint = (salt, apiToken, refreshToken) =>
  createHash('sha256').update(`${salt}\n${apiToken}\n${refreshToken}`).digest('hex').slice(0, 16);

const time = (value) => (Number.isFinite(value) ? value : undefined);

export const PAUSES = new Set(['rate', 'forbidden']);

/** The persisted state, repaired; the pause end is capped from `now`. */
export function normalizeMemory(raw, now = Date.now()) {
  const pause = raw?.pause;
  const until = time(pause?.until);
  const block = raw?.block;
  return {
    salt: typeof raw?.salt === 'string' && /^[0-9a-f]{32}$/.test(raw.salt) ? raw.salt : null,
    pause:
      until !== undefined && until > now && PAUSES.has(pause.kind)
        ? { kind: pause.kind, until: Math.min(until, now + TIMINGS.persistedPauseMax) }
        : null,
    block:
      block?.kind === 'refused' && /^[0-9a-f]{16}$/.test(block?.fingerprint ?? '')
        ? { kind: 'refused', fingerprint: block.fingerprint }
        : null,
    lastAttemptAt:
      time(raw?.lastAttemptAt) === undefined ? undefined : Math.min(raw.lastAttemptAt, now),
  };
}
