// -----------------------------------------------------------------------------
// The integration: the Lightwave account (the API token and the refresh
// token of the "API" page, the bearer token they give), one read of the
// feature values per cycle (30 to 300 s), the structures every hour, the
// Gladys devices and their states, the commands (one at a time per device,
// refused before they are sent when they cannot be answered within Gladys'
// 5 s, checked by a read after; the heating commands behind an option; "off"
// and 5 °C protective), the transport badges and the test button. index.js
// only wires the SDK handlers to it.
//
// Protective commands ("off" of a thermostat, 5 °C of a radiator valve) are
// held back neither by the option, nor by a 429/403 pause, a backoff or the
// queue of the device; after a restart they go out before the first read,
// from the feature ids kept in /data; they renew a missing bearer token, are
// sent again once on a 401, then checked by a read and sent again (3 times
// at most) while the read contradicts them. They fail when the tokens were
// refused, when the device was never read (no id kept), or on an error of
// the write (the error says which).
//
// Two clocks: `now` (wall clock) dates /data and the token; `monotonic`
// paces the reads, the pauses, the holds, the freshness and the command
// deadlines, so that a wall clock set back or forward never doubles or
// skips a read. The clock is read once per decision (`dueAt(mono)` receives
// the instant).
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { LightwaveClient } from './client.js';
import { INTERNAL_KEYS, normalizeConfig, seedHash, tokenState } from './config.js';
import { FEATURES, LIMITS, TIMINGS } from './constants.js';
import { buildDevice, deviceIds, deviceStates, planOf, protectiveSpecs } from './devices.js';
import { LightwaveError, errorReason } from './http.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { featureIdsOf, kindOf, readSets, readStructure, valuesOf } from './model.js';
import { StatePublisher } from './publisher.js';
import { BLOCKS, PAUSES, fileStore, fingerprint, newSalt, normalizeMemory } from './store.js';

/** Errors Lightwave did not answer usefully for: the account is unreachable. */
const OFFLINE = new Set([
  'network',
  'timeout',
  'unavailable',
  'bad_response',
  'size',
  'http',
  'unauthorized',
  'api_refused',
]);
/** Errors that end a cycle at once, even when an older list of structures is known. */
const FATAL = new Set([
  'refused',
  'token_rejected',
  'unauthorized',
  'api_refused',
  'rate_limited',
  'forbidden',
  'no_credentials',
]);
/**
 * Errors of the read of one structure that leave the others readable (the
 * structure keeps its last feature sets, marked unreachable).
 */
const PER_STRUCTURE = new Set([
  'forbidden',
  'http',
  'unavailable',
  'network',
  'timeout',
  'bad_response',
  'size',
]);
/** The Lightwave features read every cycle. */
const READ_TYPES = [
  FEATURES.SWITCH,
  FEATURES.DIM_LEVEL,
  FEATURES.TEMPERATURE,
  FEATURES.TARGET_TEMPERATURE,
  FEATURES.HEAT_STATE,
  FEATURES.VALVE_LEVEL,
  FEATURES.CALL_FOR_HEAT,
  FEATURES.POWER,
  FEATURES.BATTERY_LEVEL,
  FEATURES.WINDOW_POSITION,
  FEATURES.MOVEMENT,
  FEATURES.HUMIDITY,
];
/** The fields of a Gladys feature that a publication carries. */
const FEATURE_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'supported_options',
];

const expectKey = (setId, type) => `${setId}|${type}`;

export class LightwaveApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'lightwave' }),
    transport,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.client = new LightwaveClient({
      transport,
      now,
      monotonic,
      onToken: (next, previous) => this.tokenRotated(next, previous),
    });
    // The budget of 300 states a minute is measured on the monotonic clock.
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null);
    /** The structures of the account, and when they were read (monotonic). */
    this.structures = undefined;
    this.topologyAt = undefined;
    /** Structure id -> its last feature sets (kept when a later read of it fails). */
    this.lists = new Map();
    /** Ids of the feature sets of a structure whose last read failed (badge unreachable). */
    this.stale = new Set();
    /** Ids of the feature sets whose values were not read this cycle (a failed request). */
    this.unread = new Set();
    /** The last read: feature set id -> set (src/model.js), 500 at most, publishable ones. */
    this.sets = new Map();
    /** Feature set id -> `{ <type>: value }` of the last read. */
    this.values = new Map();
    /** Feature set id -> when its values were last read (monotonic). */
    this.readAt = new Map();
    /** Feature set id -> plan (src/devices.js). */
    this.plans = new Map();
    /** feature external id -> { setId, spec } */
    this.writers = new Map();
    /** feature external id -> { setId, spec, features }: protective writers from /data. */
    this.protective = new Map();
    this.readOnly = new Set();
    /** Every device published in this run, by external id: a publication never shrinks. */
    this.known = new Map();
    this.knownAccount = undefined;
    /** feature external id -> { expected, until (monotonic) }: a commanded value shown before a read. */
    this.holds = new Map();
    /** `setId|type` -> a written value a read has not confirmed yet. */
    this.expect = new Map();
    /** `setId|type` -> a warning shown in the status (a command a read contradicts). */
    this.warnings = new Map();
    /** Feature set id -> when the last protective command was received (monotonic). */
    this.protectedAt = new Map();
    /** Feature set id -> the stamp of its last protective command, while no other command follows. */
    this.protectStamps = new Map();
    /** Feature set id -> the tail of its command queue. */
    this.queues = new Map();
    /** Feature set id -> when to read it again (monotonic); one grouped read, one timer. */
    this.rereadQueue = new Map();
    this.rereadTimer = undefined;
    this.readCount = 0;
    this.dropped = 0;
    this.published = undefined;
    this.badges = new Map();
    this.timer = undefined;
    this.running = undefined;
    this.generation = 0;
    /** undefined | 'refused' | 'api_refused' | 'token_rejected' */
    this.blocked = undefined;
    this.blockStatus = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    /** Cycles in a row whose fresh bearer token the API refused. */
    this.apiRefusals = 0;
    /** The pause of every path: `{ kind, due (monotonic) }`, or the backoff after a failed read. */
    this.pause = undefined;
    /** The last read (monotonic): the next one is never sooner than the interval. */
    this.lastReadAt = undefined;
    this.lastAttemptSavedAt = undefined;
    this.lastTestAt = undefined;
    this.started = false;
    this.lastStatus = undefined;
    /** A rotated refresh token not yet saved in the Gladys configuration: `{ seed (hash), current }`. */
    this.tokenUnsaved = undefined;
    /** The refresh tokens this run rotated from (spent): a stale one sent back by Gladys is not used. */
    this.spent = new Set();
    /** The number of structures not read in the last cycle. */
    this.partial = 0;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    await this.running;
    this.config = normalizeConfig(raw);
    this.reset();
    if (this.knownAccount !== this.config.account) {
      // Another account: the devices of the previous one are not published again.
      this.known = new Map();
      this.knownAccount = this.config.account;
    }
    const now = this.now();
    const mono = this.monotonic();
    this.memory = normalizeMemory(await this.store.load().catch(() => null), now);
    if (!this.memory.salt) {
      this.memory.salt = newSalt();
      await this.saveMemory();
    }
    // The protective commands work before the first read.
    this.buildProtective();
    // A pause of every path survives a restart and a change of account.
    const pause = this.memory.pause;
    if (pause) {
      this.setPause(pause.kind, pause.until - now, mono);
    }
    // A restart never reads sooner than the interval after the last attempt.
    if (this.memory.lastAttemptAt !== undefined) {
      const since = Math.max(0, now - this.memory.lastAttemptAt);
      this.lastReadAt = mono - since;
    }
    const { apiToken, refreshToken } = this.config;
    this.client.configure({ apiToken, refreshToken });
    this.publisher.start();
    if (!this.client.hasCredentials) {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    // A stop on these very tokens survives a restart: only new tokens (or a click) lift it.
    const block = this.memory.block;
    if (block && block.fingerprint === this.fingerprint) {
      this.blocked = block.kind;
      await this.setStatus(false, this.blockMessage());
      return;
    }
    await this.setStatus(false, this.pauseMessage() ?? T.notReadYet);
    this.schedule();
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.rereadTimer !== undefined) {
      this.timers.clearTimeout(this.rereadTimer);
      this.rereadTimer = undefined;
    }
    this.rereadQueue = new Map();
    this.publisher.stop();
  }

  clearTimer() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Forgets the account and the failures: a new account, or a restart. A pause of every path stays. */
  reset() {
    this.structures = undefined;
    this.topologyAt = undefined;
    this.lists = new Map();
    this.stale = new Set();
    this.unread = new Set();
    this.sets = new Map();
    this.values = new Map();
    this.readAt = new Map();
    this.plans = new Map();
    this.writers = new Map();
    this.protective = new Map();
    this.readOnly = new Set();
    this.holds = new Map();
    this.expect = new Map();
    this.warnings = new Map();
    this.protectedAt = new Map();
    this.protectStamps = new Map();
    this.readCount = 0;
    this.dropped = 0;
    this.published = undefined;
    this.badges = new Map();
    this.blocked = undefined;
    this.blockStatus = undefined;
    this.offline = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.apiRefusals = 0;
    this.partial = 0;
    if (this.pause && !PAUSES.has(this.pause.kind)) {
      this.pause = undefined;
    }
  }

  get fingerprint() {
    return fingerprint(this.memory.salt ?? '', this.config.apiToken, this.config.refreshToken);
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badges, fresh states). The pauses, the stops and the token stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { click: false });
    this.published = undefined;
    this.badges = new Map();
    const status = this.lastStatus;
    this.lastStatus = undefined;
    if (status) {
      const [connected, message] = JSON.parse(status);
      await this.setStatus(connected, message ?? undefined);
    }
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadges();
  }

  /**
   * New tokens restart (the stop on refused tokens is lifted by new tokens
   * only); a new interval reschedules; a new language renames; the heating
   * option and the ceiling apply at the next command. Saved by the user
   * (`click`): a stop on an unexpected token answer or an API refusing the
   * bearer token is tried again.
   */
  async configUpdated(raw = {}, { click = true } = {}) {
    let next = normalizeConfig(raw);
    const previous = this.config;
    if (next.apiToken !== previous.apiToken || next.refreshToken !== previous.refreshToken) {
      const rotated = this.tokenUnsaved;
      if (
        next.apiToken === previous.apiToken &&
        next.pastedRefreshToken === previous.pastedRefreshToken &&
        ((rotated && seedHash(next.pastedRefreshToken) === rotated.seed) ||
          this.spent.has(next.refreshToken))
      ) {
        // Gladys sent the configuration back before the rotated token was
        // saved, or a page loaded before the rotation was saved again: the
        // token in memory is the right one, and it is saved (again). The
        // rest of the configuration is applied as usual.
        next = { ...next, refreshToken: previous.refreshToken };
        this.tokenUnsaved = rotated ?? {
          seed: seedHash(next.pastedRefreshToken),
          current: previous.refreshToken,
        };
        await this.saveToken();
      } else {
        this.tokenUnsaved = undefined;
        return this.start(raw);
      }
    }
    this.config = next;
    if (next.language !== previous.language) {
      this.rebuild();
      this.buildProtective();
      await this.publishDevices();
    }
    if (click && (this.blocked === 'token_rejected' || this.blocked === 'api_refused')) {
      this.blocked = undefined;
      this.blockStatus = undefined;
      this.apiRefusals = 0;
      await this.saveBlock();
      this.schedule();
      return;
    }
    if (next.pollInterval !== previous.pollInterval && this.timer !== undefined) {
      this.schedule();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The status again with the current notes, while connected. */
  async refreshStatus() {
    if (this.connectedOnce && !this.blocked && JSON.parse(this.lastStatus ?? '[false]')[0]) {
      await this.setStatus(true, this.connectedMessage());
    }
  }

  get lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? undefined;
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** Keeps the current stop (or none) in /data, tied to the tokens. */
  async saveBlock() {
    const block = BLOCKS.has(this.blocked)
      ? { kind: this.blocked, fingerprint: this.fingerprint }
      : null;
    if (JSON.stringify(block) !== JSON.stringify(this.memory.block ?? null)) {
      this.memory.block = block;
      await this.saveMemory();
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  // --- The refresh token ------------------------------------------------------

  /**
   * Lightwave gave a new refresh token (the old one is spent): kept in the
   * Gladys configuration, with a hash of the token the user pasted. Not
   * saved (Gladys unreachable): kept in memory, saved again at every cycle,
   * and said in the status.
   */
  async tokenRotated(next, previous) {
    const seed = seedHash(this.config.pastedRefreshToken);
    if (this.config.refreshToken === previous) {
      this.config = { ...this.config, refreshToken: next };
    }
    this.spent.add(previous);
    if (this.spent.size > 50) {
      this.spent.delete(this.spent.values().next().value);
    }
    this.tokenUnsaved = { seed, current: next };
    await this.saveToken();
  }

  async saveToken() {
    const unsaved = this.tokenUnsaved;
    if (!unsaved) {
      return true;
    }
    try {
      // One key: the hash and the token are always written together.
      await this.gladys.setConfig({
        [INTERNAL_KEYS.state]: tokenState(unsaved.seed, unsaved.current),
      });
      if (this.tokenUnsaved === unsaved) {
        this.tokenUnsaved = undefined;
      }
      return true;
    } catch (err) {
      this.logger.warn(`The new refresh token could not be saved in Gladys: ${err.message}`);
      return false;
    }
  }

  // --- Pace ------------------------------------------------------------------

  /** A pause of every path or a backoff, measured on the monotonic clock, capped. */
  setPause(kind, wait, mono = this.monotonic()) {
    const capped = Math.min(Math.max(0, wait), TIMINGS.persistedPauseMax);
    const due = mono + capped;
    if (!this.pause || due > this.pause.due || this.pause.kind !== kind) {
      this.pause = { kind, due: Math.max(due, this.pause?.due ?? 0) };
    }
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) {
      return 0;
    }
    const left = Math.min(Math.max(0, this.pause.due - mono), TIMINGS.persistedPauseMax);
    if (left === 0) {
      this.pause = undefined;
    }
    return left;
  }

  /** The monotonic time from which the next read may start, from the caller's instant. */
  dueAt(mono) {
    const interval = this.config.pollInterval * 1000;
    const due = this.lastReadAt === undefined ? mono : this.lastReadAt + interval;
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  /** One timer: the next read when it is due; none while stopped. */
  schedule() {
    this.clearTimer();
    if (!this.client.hasCredentials || this.blocked) {
      return;
    }
    const mono = this.monotonic();
    const wait = Math.max(0, this.dueAt(mono) - mono);
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (generation !== this.generation) {
        return undefined;
      }
      // The promise is returned for the fake timers of the tests: the real ones ignore it.
      return this.tick().catch((err) =>
        this.logger.error(`Lightwave refresh failed: ${err.message}`),
      );
    }, wait);
  }

  /** One run at a time: a tick during a run joins it. `quick`: for the button. */
  tick({ quick = false, force = false } = {}) {
    if (!this.running) {
      this.running = this.run({ quick, force }).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ quick = false, force = false } = {}) {
    const generation = this.generation;
    if (!this.client.hasCredentials || this.blocked) {
      return;
    }
    const mono = this.monotonic();
    if (!force && mono < this.dueAt(mono)) {
      this.schedule();
      return;
    }
    if (force && this.pauseLeft(mono) > 0 && PAUSES.has(this.pause?.kind)) {
      // A 429 or 403 pause holds the button too.
      this.schedule();
      return;
    }
    this.lastReadAt = mono;
    // Kept BEFORE the requests: a restart during them never reads again sooner.
    await this.saveAttempt();
    if (generation !== this.generation) {
      return;
    }
    this.client.timeout = quick ? TIMINGS.quickTimeout : undefined;
    try {
      await this.saveToken();
      if (
        !this.structures ||
        this.topologyAt === undefined ||
        mono - this.topologyAt >= TIMINGS.topologyInterval
      ) {
        await this.readTopology(mono, generation);
        if (generation !== this.generation) {
          return;
        }
      }
      const sets = this.publishable(
        readSets([...this.structures].map((s) => this.lists.get(s)).filter(Boolean)),
      );
      const read = await this.readValues(sets);
      if (generation !== this.generation) {
        return;
      }
      await this.apply(sets, read);
      this.failures = 0;
      this.apiRefusals = 0;
      this.offline = false;
      this.connectedOnce = true;
      if (this.pause?.kind === 'backoff') {
        this.pause = undefined;
      }
      await this.saveBlock();
      await this.setStatus(true, this.connectedMessage());
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    } finally {
      this.client.timeout = undefined;
    }
    await this.publishBadges();
    await this.flush();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  /**
   * The sets the integration shows (a plan), 500 at most in the order of the
   * answers; `readCount` counts every set, `dropped` those beyond 500.
   */
  publishable(all) {
    this.readCount = all.size;
    const kept = new Map();
    let shown = 0;
    for (const [id, set] of all) {
      if (!planOf(set, kindOf(set))) {
        continue;
      }
      shown += 1;
      if (kept.size < LIMITS.devices) {
        kept.set(id, set);
      }
    }
    this.dropped = shown - kept.size;
    return kept;
  }

  connectedMessage() {
    const notes = [T.connected(this.readCount, this.plans.size)];
    if (this.dropped > 0) {
      notes.push(T.dropped(this.dropped));
    }
    if (this.partial > 0) {
      notes.push(T.partial(this.partial));
    }
    if (this.unread.size > 0) {
      notes.push(T.unread(this.unread.size));
    }
    if (this.tokenUnsaved) {
      notes.push(T.tokenNotSaved);
    }
    notes.push(...[...this.warnings.values()].slice(0, LIMITS.warnings));
    return join(...notes);
  }

  /** The time of the attempt in /data, at most once a minute. */
  async saveAttempt() {
    const now = this.now();
    if (
      this.lastAttemptSavedAt !== undefined &&
      now - this.lastAttemptSavedAt < TIMINGS.attemptWriteInterval
    ) {
      return;
    }
    this.lastAttemptSavedAt = now;
    this.memory.lastAttemptAt = now;
    await this.saveMemory();
  }

  /**
   * The hierarchy, every hour: the structures of the account, then the
   * feature sets of each, each structure read on its own: one that fails
   * keeps its last sets (badge unreachable, read again in 5 min) and the
   * others go on. Only when every structure fails is the error the cycle's.
   */
  async readTopology(mono, generation) {
    try {
      this.structures = await this.client.structures();
    } catch (err) {
      if (!this.structures || FATAL.has(err.kind)) {
        throw err;
      }
      // The structures known keep working; they are read again next cycle.
      this.logger.info(`Lightwave structures not read again: ${errorReason(err)}`);
    }
    if (generation !== this.generation) {
      return;
    }
    const lists = new Map();
    const failures = new Map();
    for (const structure of this.structures) {
      try {
        lists.set(structure, readStructure(await this.client.structure(structure), structure));
      } catch (err) {
        const own = err instanceof LightwaveError && PER_STRUCTURE.has(err.kind);
        if (!own) {
          throw err;
        }
        failures.set(structure, err);
      }
    }
    if (failures.size > 0 && lists.size === 0) {
      throw [...failures.values()][0];
    }
    for (const structure of [...this.lists.keys()]) {
      if (!this.structures.includes(structure)) {
        this.lists.delete(structure);
      }
    }
    this.stale = new Set();
    for (const [structure, list] of lists) {
      this.lists.set(structure, list);
    }
    for (const [structure, err] of failures) {
      this.logger.info(`Lightwave: one structure not read (${errorReason(err)})`);
      for (const set of this.lists.get(structure) ?? []) {
        this.stale.add(set.id);
      }
    }
    this.partial = failures.size;
    // A structure not read: the hierarchy is tried again in 5 minutes, not an hour.
    this.topologyAt =
      failures.size > 0 ? mono - TIMINGS.topologyInterval + TIMINGS.topologyRetry : mono;
  }

  /** The values of the features of the shown sets read this cycle (the stale ones keep their old values). */
  async readValues(sets) {
    const fresh = new Map([...sets].filter(([id]) => !this.stale.has(id)));
    const ids = featureIdsOf(fresh, READ_TYPES);
    return ids.length === 0
      ? { values: new Map(), failed: new Set() }
      : this.client.readFeatures(ids);
  }

  /** Whether a feature of the set was in a request that failed (or beyond the cap). */
  missed(set, failed) {
    return Object.values(set.features).some((id) => failed.has(id));
  }

  async apply(sets, { values, failed }) {
    const mono = this.monotonic();
    this.sets = sets;
    this.unread = new Set();
    const read = [];
    for (const set of sets.values()) {
      if (this.stale.has(set.id)) {
        continue;
      }
      if (this.missed(set, failed)) {
        this.unread.add(set.id);
        continue;
      }
      this.values.set(set.id, valuesOf(set, values));
      this.readAt.set(set.id, mono);
      read.push(set.id);
    }
    for (const id of [...this.values.keys()]) {
      if (!sets.has(id)) {
        this.values.delete(id);
        this.readAt.delete(id);
      }
    }
    this.rebuild();
    await this.keepProtective();
    for (const id of read) {
      this.checkExpectations(id, mono);
    }
    await this.publishDevices();
    this.queueStates();
  }

  /** The plans and the writers of the last read. */
  rebuild() {
    this.plans = new Map();
    this.writers = new Map();
    this.readOnly = new Set();
    for (const set of this.sets.values()) {
      const plan = planOf(set, kindOf(set), this.config.language);
      if (!plan) {
        continue;
      }
      this.plans.set(set.id, plan);
      const ids = deviceIds(this.gladys, set.id);
      for (const spec of plan.specs) {
        if (spec.write) {
          this.writers.set(ids.feature(spec.key), { setId: set.id, spec });
        } else {
          this.readOnly.add(ids.feature(spec.key));
        }
      }
    }
  }

  /** The protective writers of the heating sets kept in /data. */
  buildProtective() {
    this.protective = new Map();
    for (const [setId, features] of Object.entries(this.memory.protect ?? {})) {
      const ids = deviceIds(this.gladys, setId);
      for (const spec of protectiveSpecs(features, this.config.language)) {
        this.protective.set(ids.feature(spec.key), { setId, spec, features });
      }
    }
  }

  /** The feature ids of the heating sets of the last read, kept in /data when they change. */
  async keepProtective() {
    const protect = {};
    for (const [id, plan] of this.plans) {
      if (plan.kind !== 'climate') {
        continue;
      }
      const set = this.sets.get(id);
      const kept = {};
      for (const type of [FEATURES.HEAT_STATE, FEATURES.TARGET_TEMPERATURE]) {
        if (set.features[type]) {
          kept[type] = set.features[type];
        }
      }
      if (Object.keys(kept).length > 0) {
        protect[id] = kept;
      }
    }
    if (JSON.stringify(protect) !== JSON.stringify(this.memory.protect ?? {})) {
      this.memory.protect = protect;
      this.buildProtective();
      await this.saveMemory();
    }
  }

  /** A pause of every path (429, 403), kept in /data. */
  async pauseAll(err) {
    let wait;
    let kind;
    if (err.kind === 'rate_limited') {
      wait = Math.min(
        TIMINGS.rateLimitMax,
        Math.max(TIMINGS.rateLimitMin, err.retryAfter ?? TIMINGS.rateLimitDefault),
      );
      kind = 'rate';
    } else {
      wait = TIMINGS.forbiddenPause;
      kind = 'forbidden';
      this.offline = true;
    }
    const mono = this.monotonic();
    this.setPause(kind, wait, mono);
    this.memory.pause = { kind, until: this.now() + (this.pause.due - mono) };
    await this.saveMemory();
    return wait;
  }

  blockMessage() {
    switch (this.blocked) {
      case 'refused':
        return T.refused;
      case 'api_refused':
        return T.apiRefusedStop;
      default:
        return T.tokenRejected(this.blockStatus ?? '?');
    }
  }

  async failed(err) {
    const reason = errorReason(err);
    if (err.kind === 'no_credentials') {
      await this.setStatus(false, T.noCredentials);
      return;
    }
    if (err.kind === 'refused' || err.kind === 'token_rejected') {
      // Never tried again by itself: a refused refresh token is spent, and
      // new tries could lock the account. New tokens (refused) or a click
      // (an unexpected answer) lift it.
      this.blocked = err.kind;
      this.blockStatus = err.status;
      this.clearTimer();
      await this.saveBlock();
      this.logger.warn(`Lightwave stopped: ${reason}`);
      await this.setStatus(false, this.blockMessage());
      return;
    }
    this.offline = OFFLINE.has(err.kind) || this.offline;
    if (err.kind === 'api_refused') {
      // The API refuses a token it has just issued: no new token (it would
      // spend a refresh token each time), spaced tries, a stop at the 3rd.
      this.apiRefusals += 1;
      if (this.apiRefusals >= TIMINGS.apiRefusedStop) {
        this.blocked = 'api_refused';
        this.clearTimer();
        await this.saveBlock();
        this.logger.warn(`Lightwave stopped: ${reason}, ${this.apiRefusals} times in a row`);
        await this.setStatus(false, this.blockMessage());
        return;
      }
      const wait = Math.min(
        TIMINGS.apiRefusedMax,
        Math.max(this.config.pollInterval * 1000, TIMINGS.apiRefusedBase) *
          2 ** (this.apiRefusals - 1),
      );
      this.setPause('backoff', wait);
      await this.setStatus(false, T.apiRefused(age(wait)));
      this.logger.warn(`Lightwave: ${reason}; next try in ${Math.round(wait / 1000)} s`);
      return;
    }
    let wait;
    let message;
    if (err.kind === 'rate_limited' || err.kind === 'forbidden') {
      wait = await this.pauseAll(err);
      message = this.pauseMessage();
    } else {
      // Never read again sooner than the interval.
      wait = Math.max(
        this.config.pollInterval * 1000,
        TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
      );
      this.setPause('backoff', wait);
      message = T.unreachable(reason, age(wait));
    }
    this.failures += 1;
    const connected = err.kind === 'rate_limited' && this.connectedOnce;
    await this.setStatus(connected, message);
    this.logger.warn(`Lightwave: ${reason}; next try in ${Math.round(wait / 1000)} s`);
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevices() {
    return new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /**
   * The devices of the last read, merged so that nothing ever disappears: a
   * created device keeps its features as Gladys has them (types and units are
   * fixed at creation), plus any new one; a device or a feature seen earlier
   * in this run stays published.
   */
  async publishDevices() {
    const created = this.createdDevices();
    for (const set of this.sets.values()) {
      const plan = this.plans.get(set.id);
      if (!plan) {
        continue;
      }
      const fresh = buildDevice(this.gladys, set, plan, this.config.language);
      const previous = this.known.get(fresh.external_id);
      const mine = created.get(fresh.external_id);
      const features = new Map();
      for (const f of mine?.features ?? []) {
        features.set(
          f.external_id,
          Object.fromEntries(
            FEATURE_FIELDS.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
          ),
        );
      }
      for (const f of [...(previous?.features ?? []), ...fresh.features]) {
        if (!features.has(f.external_id)) {
          features.set(f.external_id, f);
        }
      }
      if (!previous && this.known.size >= LIMITS.devices) {
        continue;
      }
      this.known.set(fresh.external_id, { ...fresh, features: [...features.values()] });
    }
    const list = [...this.known.values()];
    const json = JSON.stringify(list);
    if (list.length === 0 || json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(list);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** A commanded value waiting for its confirmation hides an older read one. */
  held(featureId, state, mono) {
    const hold = this.holds.get(featureId);
    if (!hold) {
      return false;
    }
    if (mono >= hold.until || state === hold.expected) {
      this.holds.delete(featureId);
      return false;
    }
    return true;
  }

  /** The values older than this are never published again. */
  maxAge() {
    return Math.max(2 * this.config.pollInterval * 1000, TIMINGS.staleAge);
  }

  /**
   * The current values in the publisher's queue: only the sets read
   * recently (a stale value is never sent again as a new one: after an
   * outage, an update of the device, a reconnection to Gladys).
   */
  queueStates(created = this.createdFeatures(), only) {
    const mono = this.monotonic();
    const maxAge = this.maxAge();
    for (const [id, plan] of this.plans) {
      if ((only && id !== only) || this.stale.has(id) || this.unread.has(id)) {
        continue;
      }
      const readAt = this.readAt.get(id);
      if (readAt === undefined || mono - readAt > maxAge) {
        continue;
      }
      const set = this.sets.get(id);
      const values = this.values.get(id);
      if (!set || !values) {
        continue;
      }
      for (const { device_feature_external_id: featureId, state } of deviceStates(
        this.gladys,
        set,
        values,
        plan,
      )) {
        if (created.has(featureId) && !this.held(featureId, state, mono)) {
          this.publisher.push(featureId, { state });
        }
      }
    }
  }

  /** One badge per created device: cloud, or unreachable (stopped, unreachable, not read). */
  async publishBadges() {
    const entries = [];
    const byDevice = new Map(
      [...this.sets.keys()].map((id) => [deviceIds(this.gladys, id).device, id]),
    );
    for (const device of this.gladys.devices ?? []) {
      if (!this.known.has(device.external_id)) {
        continue;
      }
      const id = byDevice.get(device.external_id);
      const unreachable =
        this.blocked || this.offline || !id || this.stale.has(id) || this.unread.has(id);
      const transport = unreachable ? DEVICE_TRANSPORTS.UNREACHABLE : DEVICE_TRANSPORTS.CLOUD;
      if (this.badges.get(device.external_id) !== transport) {
        entries.push({ external_id: device.external_id, transport });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.badges.set(entry.external_id, entry.transport);
        }
      } catch (err) {
        this.logger.warn(`Transport badges failed: ${err.message}`);
      }
    }
  }

  async deviceCreated(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
    }
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadges();
  }

  async deviceDeleted(device) {
    if (device?.external_id) {
      this.badges.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the devices of the last read (no extra request). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Commands --------------------------------------------------------------

  error(text) {
    return new Error(word(text, this.config.language));
  }

  /**
   * A command. A protective one ("off", 5 °C) goes through `protect`; any
   * other one through the queue of its device.
   */
  async setValue(device, feature, value) {
    const received = this.monotonic();
    const featureId = feature?.external_id;
    let writer = this.writers.get(featureId);
    const early = !writer;
    writer ??= this.protective.get(featureId);
    if (!writer) {
      if (this.readOnly.has(featureId)) {
        throw this.error(ERRORS.readOnly);
      }
      throw this.error(this.sets.size === 0 ? ERRORS.notReadYet : ERRORS.unknown);
    }
    const number = Number(value);
    if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(number)) {
      throw this.error(ERRORS.invalidValue);
    }
    const { setId, spec } = writer;
    const protective = Boolean(spec.protective?.(number));
    if (early && !protective) {
      throw this.error(ERRORS.onlyProtectiveYet);
    }
    if (!this.client.hasCredentials) {
      throw this.error(ERRORS.blocked);
    }
    if (this.blocked === 'refused') {
      throw this.error(ERRORS.tokensRefused);
    }
    const generation = this.generation;
    if (protective) {
      await this.protect(writer, number, received, generation);
      return;
    }
    if (this.blocked) {
      throw this.error(ERRORS.blocked);
    }
    const paused = this.commandPause(received);
    if (paused) {
      throw this.error(paused);
    }
    await this.serial(
      setId,
      () => this.command(setId, spec, number, received, generation),
      received + TIMINGS.commandSendBy,
    );
  }

  /** The message of a pause that holds the commands (429, 403), else undefined. */
  commandPause(mono = this.monotonic()) {
    if (this.pauseLeft(mono) === 0 || !PAUSES.has(this.pause?.kind)) {
      return undefined;
    }
    return this.pauseMessage(mono) ?? ERRORS.paused;
  }

  /**
   * One command at a time per device: each waits for the previous one,
   * including a request still finishing in the background, but never past
   * `sendBy` (monotonic): still waiting then, it is refused unsent.
   */
  serial(setId, job, sendBy) {
    const previous = this.queues.get(setId) ?? Promise.resolve();
    let handle;
    const late = new Promise((resolve) => {
      handle = this.timers.setTimeout(() => resolve(false), Math.max(0, sendBy - this.monotonic()));
    });
    const run = Promise.race([previous.then(() => true), late]).then((ready) => {
      this.timers.clearTimeout(handle);
      if (!ready) {
        throw this.error(ERRORS.late);
      }
      return job();
    });
    const tail = Promise.all([
      previous,
      run.then(
        (result) => result?.background,
        () => {},
      ),
    ]).then(() => undefined);
    this.queues.set(setId, tail);
    tail.finally(() => {
      if (this.queues.get(setId) === tail) {
        this.queues.delete(setId);
      }
    });
    return run.then(() => undefined);
  }

  /**
   * A protective command ("off", 5 °C): held back neither by the option, a
   * pause, a backoff nor the queue; the device known by the last read or by
   * the ids kept in /data. Commands of the device still waiting in the queue
   * are cancelled; one in flight makes it sticky: sent again once that one
   * is answered.
   */
  async protect(writer, number, received, generation) {
    const { setId, spec, features } = writer;
    const set = this.sets.get(setId) ?? { id: setId, features };
    const payload = spec.write(number, this.values.get(setId) ?? {}, this.config);
    if (payload.refuse) {
      throw this.error(ERRORS[payload.refuse]);
    }
    const writes = payload.writes
      .map(({ type, value }) => ({ type, value, id: set.features[type] }))
      .filter((w) => w.id);
    if (writes.length === 0) {
      throw this.error(ERRORS.unknown);
    }
    this.protectedAt.set(setId, received);
    const stamp = {};
    this.protectStamps.set(setId, stamp);
    const inFlight = this.queues.get(setId);
    if (inFlight) {
      inFlight.then(() => {
        if (generation === this.generation && this.protectStamps.get(setId) === stamp) {
          this.logger.info('Lightwave: protective command sent again after the one in flight');
          this.resend(setId, writes, { confirm: true });
        }
      });
    }
    this.logger.info(`Lightwave protective command: ${spec.key}`);
    await this.send(setId, writes, received, generation, true);
  }

  /**
   * Builds the writes (the option and the ceiling read from the
   * configuration right now) of a command that is not protective.
   */
  async command(setId, spec, number, received, generation) {
    const sendBy = received + TIMINGS.commandSendBy;
    const set = this.sets.get(setId);
    if (!set || generation !== this.generation) {
      throw this.error(ERRORS.unknown);
    }
    if ((this.protectedAt.get(setId) ?? -Infinity) > received) {
      // An "off" given after this command, while it waited in the queue.
      throw this.error(ERRORS.cancelledByOff);
    }
    const payload = spec.write(number, this.values.get(setId) ?? {}, this.config);
    if (payload.refuse) {
      throw this.error(ERRORS[payload.refuse]);
    }
    if (this.blocked) {
      throw this.error(ERRORS.blocked);
    }
    const mono = this.monotonic();
    const paused = this.commandPause(mono);
    if (paused) {
      throw this.error(paused);
    }
    if (sendBy - mono < 300 || this.client.authenticating) {
      // Too late, or a renewal runs (the command would leave after it): unsent.
      throw this.error(ERRORS.late);
    }
    const writes = payload.writes
      .map(({ type, value }) => ({ type, value, id: set.features[type] }))
      .filter((w) => w.id);
    if (writes.length === 0) {
      throw this.error(ERRORS.unknown);
    }
    // A newer command of the device: a sticky "off" is not sent again over it.
    this.protectStamps.delete(setId);
    this.logger.info(`Lightwave command: ${spec.key} of a ${this.plans.get(setId)?.kind}`);
    return this.send(setId, writes, received, generation, false);
  }

  /**
   * Sends the writes once, one after the other. Gladys waits 5 s: a command
   * that is not protective is never sent later than 3 s after the click
   * (refused unsent); a protective one may leave later (it renews a missing
   * token first), and Gladys then hears it is not sent yet. Gladys is
   * answered at 4.3 s at the latest; the requests then finish in the
   * background, and their promise is returned as `background` (the next
   * command of the device waits for it). The writes are then checked by a
   * read.
   */
  async send(setId, writes, received, generation, protective) {
    const sendBy = received + TIMINGS.commandSendBy;
    let sent = false;
    const done = [];
    const request = (async () => {
      for (const [index, write] of writes.entries()) {
        const options = {
          timeout: TIMINGS.requestTimeout,
          onSent: () => {
            sent = true;
          },
        };
        if (protective) {
          options.protective = true;
        } else if (index === 0) {
          const left = sendBy - this.monotonic();
          if (left < 100) {
            throw new LightwaveError('timeout', 'not sent in time', { notSent: true });
          }
          options.sendWithin = left;
        }
        // A second write (the "on" after a brightness) goes even past the
        // deadline: the first one has left, the command is under way.
        await this.client.writeFeature(write.id, write.value, options);
        done.push(write);
      }
    })();
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(
        () => resolve({ pending: true }),
        Math.max(0, received + TIMINGS.commandAck - this.monotonic()),
      );
    });
    const outcome = await Promise.race([
      request.then(
        () => ({ done: true }),
        (err) => ({ err }),
      ),
      ack,
    ]);
    this.timers.clearTimeout(handle);
    if (outcome.pending) {
      // Lightwave (or the token endpoint) still at work: Gladys is answered now.
      const background = request
        .then(
          () => {
            if (generation === this.generation) {
              this.confirm(setId, done, protective, received);
            }
          },
          async (err) => {
            this.logger.warn(`Lightwave command failed: ${errorReason(err)}`);
            if (generation === this.generation && err.kind === 'rate_limited') {
              await this.pauseAll(err);
              await this.setStatus(this.connectedOnce, this.pauseMessage());
            }
          },
        )
        .finally(() => {
          if (generation === this.generation) {
            this.scheduleReread(setId);
          }
        });
      if (!sent) {
        background.catch(() => {});
        if (!protective) {
          // Never left (its send limit destroys it): Gladys hears it was not sent.
          throw this.error(ERRORS.late);
        }
        throw this.error(ERRORS.offPending);
      }
      return { background };
    }
    if (outcome.err) {
      throw await this.commandFailure(outcome.err, setId, sent);
    }
    this.confirm(setId, done, protective, received);
    this.scheduleReread(setId);
    return {};
  }

  /**
   * The values written: shown at once, held 15 s against an older read, and
   * expected: a read that contradicts them is warned about (and a
   * protective one sent again). A write of a command an "off" given later
   * superseded is neither shown nor expected.
   */
  confirm(setId, writes, protective, received) {
    if (!protective && (this.protectedAt.get(setId) ?? -Infinity) > received) {
      return;
    }
    const mono = this.monotonic();
    for (const write of writes) {
      const key = expectKey(setId, write.type);
      this.expect.set(key, {
        setId,
        type: write.type,
        id: write.id,
        value: write.value,
        protective,
        tries: 0,
        until: mono + TIMINGS.commandHold,
      });
      this.warnings.delete(key);
    }
    const set = this.sets.get(setId);
    const plan = this.plans.get(setId);
    const before = this.values.get(setId);
    if (!set || !plan || !before) {
      return;
    }
    const after = { ...before };
    for (const write of writes) {
      after[write.type] = write.value;
    }
    this.values.set(setId, after);
    const old = new Map(
      deviceStates(this.gladys, set, before, plan).map((s) => [
        s.device_feature_external_id,
        s.state,
      ]),
    );
    this.queueStates(undefined, setId);
    // Set after the confirmed values are queued: they are the expected ones.
    for (const { device_feature_external_id: id, state } of deviceStates(
      this.gladys,
      set,
      after,
      plan,
    )) {
      if (old.get(id) !== state) {
        this.holds.set(id, { expected: state, until: mono + TIMINGS.commandHold });
      }
    }
    this.flush();
  }

  /** Drops the holds of a set: the value read is shown. */
  dropHolds(setId) {
    const prefix = `${deviceIds(this.gladys, setId).device}:`;
    for (const id of [...this.holds.keys()]) {
      if (id.startsWith(prefix)) {
        this.holds.delete(id);
      }
    }
  }

  /**
   * The written values of a set against the values just read: equal, done;
   * different: a protective one is sent again (3 times at most) and the read
   * shown; another one is warned about once its 15 s are over.
   */
  checkExpectations(setId, mono) {
    const values = this.values.get(setId);
    const name = this.sets.get(setId)?.name ?? setId;
    for (const [key, e] of [...this.expect]) {
      if (e.setId !== setId) {
        continue;
      }
      const read = values?.[e.type];
      if (read === undefined) {
        continue;
      }
      if (read === e.value) {
        this.expect.delete(key);
        this.warnings.delete(key);
        continue;
      }
      if (e.protective) {
        this.dropHolds(setId);
        this.warnings.set(key, T.offNotApplied(name));
        if (e.tries < TIMINGS.protectiveResends) {
          e.tries += 1;
          this.logger.warn(
            `Lightwave: a protective command is not what the device reads back; sent again (${e.tries})`,
          );
          this.resend(setId, [e]);
        } else {
          this.expect.delete(key);
          this.logger.warn('Lightwave: a protective command did not take effect');
        }
      } else if (mono >= e.until) {
        this.expect.delete(key);
        this.warnings.set(key, T.notApplied(name));
        this.logger.warn('Lightwave: a command is not what the device reads back 15 s later');
      } else {
        this.scheduleReread(setId, e.until - mono + 500);
      }
    }
  }

  /** A protective write sent again in the background, the set read again after. */
  resend(setId, writes, { confirm = false } = {}) {
    const generation = this.generation;
    const job = (async () => {
      for (const write of writes) {
        await this.client.writeFeature(write.id, write.value, {
          protective: true,
          timeout: TIMINGS.requestTimeout,
        });
      }
    })();
    return job
      .then(
        () => {
          if (confirm && generation === this.generation) {
            this.confirm(setId, writes, true, this.monotonic());
          }
        },
        (err) =>
          this.logger.warn(`Lightwave: protective command not sent again: ${errorReason(err)}`),
      )
      .finally(() => {
        if (generation === this.generation) {
          this.scheduleReread(setId);
        }
        return this.refreshStatus();
      });
  }

  /** The set is read again after `delay`; the sets due together are read in one request. */
  scheduleReread(setId, delay = TIMINGS.rereadAfterCommand) {
    const due = this.monotonic() + delay;
    const current = this.rereadQueue.get(setId);
    if (current === undefined || due < current) {
      this.rereadQueue.set(setId, due);
    }
    this.armReread();
  }

  armReread() {
    if (this.rereadTimer !== undefined) {
      this.timers.clearTimeout(this.rereadTimer);
      this.rereadTimer = undefined;
    }
    if (this.rereadQueue.size === 0) {
      return;
    }
    const mono = this.monotonic();
    const first = Math.min(...this.rereadQueue.values());
    const generation = this.generation;
    this.rereadTimer = this.timers.setTimeout(
      () => {
        this.rereadTimer = undefined;
        if (generation !== this.generation) {
          return undefined;
        }
        return this.rereadDue(generation).catch(() => {});
      },
      Math.max(0, first - mono),
    );
  }

  async rereadDue(generation) {
    const mono = this.monotonic();
    // The sets due within the next half second are read together.
    const due = [...this.rereadQueue].filter(([, at]) => at <= mono + 500).map(([id]) => id);
    for (const id of due) {
      this.rereadQueue.delete(id);
    }
    try {
      await this.reread(due, generation);
    } finally {
      if (generation === this.generation) {
        this.armReread();
      }
    }
  }

  async reread(setIds, generation) {
    const sets = new Map(
      setIds.filter((id) => this.sets.has(id)).map((id) => [id, this.sets.get(id)]),
    );
    const mono = this.monotonic();
    if (
      sets.size === 0 ||
      this.blocked ||
      (this.pauseLeft(mono) > 0 && PAUSES.has(this.pause?.kind)) ||
      !this.client.session
    ) {
      return;
    }
    try {
      const ids = featureIdsOf(sets, READ_TYPES);
      const { values, failed } = await this.client.readFeatures(ids, { allowRefresh: false });
      if (generation !== this.generation) {
        return;
      }
      const at = this.monotonic();
      for (const [id, set] of sets) {
        if (!this.sets.has(id) || this.missed(set, failed)) {
          continue;
        }
        this.values.set(id, { ...this.values.get(id), ...valuesOf(set, values) });
        this.readAt.set(id, at);
        this.checkExpectations(id, at);
        this.queueStates(undefined, id);
      }
      await this.flush();
      await this.publishBadges();
      await this.refreshStatus();
    } catch (err) {
      this.logger.info(`Lightwave devices not read again: ${errorReason(err)}`);
      if (err.kind === 'rate_limited' && generation === this.generation) {
        await this.pauseAll(err);
        await this.setStatus(this.connectedOnce, this.pauseMessage());
      }
    }
  }

  async commandFailure(err, setId, sent) {
    if (!(err instanceof LightwaveError)) {
      return err;
    }
    const reason = errorReason(err);
    this.logger.warn(`Lightwave command not done: ${reason}`);
    switch (err.kind) {
      case 'rate_limited':
        await this.pauseAll(err);
        await this.setStatus(this.connectedOnce, this.pauseMessage());
        return this.error(this.pauseMessage() ?? ERRORS.paused);
      case 'unauthorized':
        // No token, or refused: the next cycle renews it; nothing was done.
        return this.error(err.notSent || !sent ? ERRORS.blocked : ERRORS.refused(reason));
      case 'refused':
        return this.error(ERRORS.tokensRefused);
      case 'timeout':
      case 'network':
        if (err.notSent && !sent) {
          return this.error(ERRORS.late);
        }
        this.scheduleReread(setId);
        return this.error(ERRORS.unsure(reason));
      case 'unavailable':
      case 'bad_response':
      case 'size':
        // Answered, but not as expected: the command may have been done.
        this.scheduleReread(setId);
        return this.error(ERRORS.unsure(reason));
      default:
        // A 403 of a command is that command refused, never a pause of everything.
        return this.error(ERRORS.refused(reason));
    }
  }

  // --- Configuration button -----------------------------------------------------

  /** A pause of every path holds for the button too. */
  pauseMessage(mono = this.monotonic()) {
    const left = this.pauseLeft(mono);
    if (left <= 0) {
      return undefined;
    }
    switch (this.pause?.kind) {
      case 'rate':
        return T.rateLimited(age(left));
      case 'forbidden':
        return T.forbidden(age(left));
      default:
        return undefined;
    }
  }

  async testConnection() {
    if (!this.client.hasCredentials) {
      return T.noCredentials;
    }
    if (this.blocked === 'refused') {
      // A refused refresh token is spent: trying again would not help.
      return T.refused;
    }
    const mono = this.monotonic();
    const paused = this.pauseMessage(mono);
    if (paused) {
      return paused;
    }
    if (this.lastTestAt !== undefined && mono - this.lastTestAt < TIMINGS.testCooldown) {
      const last = this.lastMessage;
      return last ? join(T.test.cooldown, last) : T.test.cooldown;
    }
    if (this.running) {
      return T.busy;
    }
    this.lastTestAt = mono;
    // One read per click, never sooner than the interval after the last one;
    // an unexpected token answer or an API refusal is tried again.
    this.blocked = undefined;
    this.blockStatus = undefined;
    this.apiRefusals = 0;
    await this.saveBlock();
    if (this.pause?.kind === 'backoff') {
      this.pause = undefined;
    }
    const due = this.dueAt(mono);
    if (mono < due) {
      // Never a read sooner than the interval: the next one is already on its way.
      this.schedule();
      const soon = T.test.tooSoon(Math.round((due - mono) / 1000));
      const last = this.lastMessage;
      return last ? join(soon, last) : soon;
    }
    await this.tick({ quick: true, force: true });
    return this.lastMessage ?? T.noCredentials;
  }
}
